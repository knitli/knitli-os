// Ported from michielappelman/cloudflare-os 162f9d7 (Apache-2.0), extended for the hourly cap and
// the stricter validation.
import { describe, expect, it } from "vitest";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import {
  assertMayDeliverFrom, checkSendQuota, createEmailSend, emailActions, MAX_RECIPIENTS_PER_HOUR, prepareSend,
  SEND_EMAIL_ACTION, type SendEmailPayload,
} from "../../src/fork/send";
import type { OutgoingEmail } from "../../src/types";

const FROM = "gadget-agent@mail.example.com";
const POLICY = { domain: "mail.example.com", mailboxPrefix: "gadget-" };
const ENV = { EMAIL_DOMAIN: POLICY.domain, EMAIL_SEND_PREFIX: POLICY.mailboxPrefix };

function mapKv() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: (key: string, value: unknown) => void values.set(key, structuredClone(value)),
    delete: (key: string) => void values.delete(key),
    list: <T>({ prefix, startAfter, limit }:
        { prefix: string; startAfter?: string; limit?: number }) => {
      const found = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
        .toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, value]) => [key, structuredClone(value)] as [string, T]);
      return limit === undefined ? found : found.slice(0, limit);
    },
  };
}

function setup(send: (message: EmailMessageBuilder) => Promise<EmailSendResult>,
    kv = mapKv()) {
  const sent: EmailMessageBuilder[] = [];
  const submitted = new Map<number, ActionDescription>();
  const sender = { send: async (message: EmailMessageBuilder) => {
    const result = await send(message);
    sent.push(message);
    return result;
  } } as SendEmail;
  const actions = emailActions.bind(
      new ActionJournal<TaggedAction<{ send: SendEmailPayload }>>(kv, { namespace: "email-send" }),
      { sender, kv, policy: POLICY });
  const queue = {
    submitAction: async (id: number, description: ActionDescription) =>
      void submitted.set(id, description),
  };
  return {
    sent, submitted, actions, kv, queue,
    submit: async (email: OutgoingEmail) =>
      actions.submit(queue as never, "send", await prepareSend(email, FROM)),
  };
}

const ok = async () => ({ messageId: "<sent@mail.example.com>" });

describe("sending email", () => {
  it("sends nothing until approved, then sends from the bound mailbox", async () => {
    const { sent, submitted, actions, submit } = setup(ok);
    const pdf = new Uint8Array([1, 2, 3]).buffer;
    const id = await submit({
      to: ["alice@example.com"],
      cc: ["bob@example.com"],
      bcc: ["carol@example.com"],
      subject: "Hello",
      text: "Body text",
      html: "<b>Body</b>",
      fromName: "Agent",
      inReplyTo: "<orig@example.com>",
      attachments: [{ filename: "a.pdf", mimeType: "Application/PDF", content: pdf }],
    });

    expect(sent).toEqual([]);
    const description = submitted.get(id)!;
    expect(description.actionKind).toEqual(SEND_EMAIL_ACTION);
    expect(description.autoApprovable).toBe(true);
    expect(description.awaitDecision).toBe(true);
    expect(description.implementsRevert).toBe(false);
    // The approver sees every recipient (Bcc included) and both bodies as literal text.
    expect(description.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "From", value: `Agent <${FROM}>` }),
      expect.objectContaining({ label: "To", items: ["alice@example.com"] }),
      expect.objectContaining({ label: "Cc", items: ["bob@example.com"] }),
      expect.objectContaining({ label: "Bcc", items: ["carol@example.com"] }),
      expect.objectContaining({ label: "Subject", value: "Hello" }),
      expect.objectContaining({ label: "Text body", value: "Body text" }),
      expect.objectContaining({ label: "HTML body", value: "<b>Body</b>", syntax: "html" }),
      expect.objectContaining({
        label: "Attachment", name: "a.pdf", mediaType: "application/pdf", size: 3, origin: "agent",
      }),
    ]));

    await actions.apply(id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { name: "Agent", email: FROM },
      to: ["alice@example.com"],
      cc: ["bob@example.com"],
      bcc: ["carol@example.com"],
      subject: "Hello",
      text: "Body text",
      html: "<b>Body</b>",
      headers: { "In-Reply-To": "<orig@example.com>", "References": "<orig@example.com>" },
    });
    // Base64, since the local email simulator cannot serialize binary content.
    expect(sent[0]!.attachments![0]!.content).toBe("AQID");

    // Re-applying an applied action must not send it twice.
    await actions.apply(id);
    expect(sent).toHaveLength(1);
  });

  it("keeps a transient binding failure retryable, and refunds its allowance", async () => {
    let attempts = 0;
    const { sent, actions, submit, kv } = setup(async () => {
      if (attempts++ === 0) throw Object.assign(new Error("slow down"), { code: "E_RATE_LIMIT_EXCEEDED" });
      return { messageId: "<m@x.com>" };
    });
    const id = await submit({ to: ["alice@example.com"], subject: "Hi", text: "x" });
    await expect(actions.apply(id)).rejects.toThrow(/slow down/);
    expect(kv.get<unknown[]>("email-send:quota")).toEqual([]);
    await actions.apply(id);
    expect(sent).toHaveLength(1);
  });

  it("never sends a rejected message", async () => {
    const { sent, actions, submit } = setup(ok);
    const id = await submit({ to: ["alice@example.com"], subject: "Hi", text: "x" });
    await actions.reject(id);
    await expect(actions.apply(id)).rejects.toThrow(/Unknown pending action/);
    expect(sent).toEqual([]);
  });

  it("does not retry a send the binding rejected", async () => {
    let attempts = 0;
    const { actions, submit } = setup(async () => {
      attempts++;
      throw new Error("destination address not verified");
    });
    const id = await submit({ to: ["alice@example.com"], subject: "Hi", text: "x" });
    await actions.apply(id).catch(() => {});
    await actions.apply(id).catch(() => {});
    expect(attempts).toBe(1);
  });

  it("only offers sending as an always-allow kind", () => {
    const { actions } = setup(ok);
    expect(actions.autoApprovableKinds()).toEqual([SEND_EMAIL_ACTION]);
  });
});

const manyRecipients = (n: number, tag = "u") =>
  Array.from({ length: n }, (_, i) => `${tag}${i}@example.com`);

describe("sender namespace", () => {
  it.each<[string, string, Partial<typeof POLICY>, RegExp]>([
    ["unset domain", FROM, { domain: undefined }, /not enabled/],
    ["unset prefix", FROM, { mailboxPrefix: undefined }, /not enabled/],
    ["a reserved name", "admin@mail.example.com", {}, /cannot send/],
    ["another domain", "gadget-a@evil.example.com", {}, /cannot send/],
  ])("refuses %s", (_name, from, override, error) => {
    expect(() => assertMayDeliverFrom(from, { ...POLICY, ...override })).toThrow(error);
  });

  it("allows an address inside the namespace, case-insensitively", () => {
    expect(() => assertMayDeliverFrom("Gadget-A@Mail.Example.com", POLICY)).not.toThrow();
  });

  it("refuses to queue a send from outside it, and to apply one queued before the policy changed",
      async () => {
    const { queue } = setup(ok);
    const send = createEmailSend(mapKv(), { ...ENV, SEND_EMAIL: { send: ok } as SendEmail });
    const email = { to: ["alice@example.com"], subject: "Hi", text: "x" };
    await expect(send.submit(queue as never, email, "admin@mail.example.com")).rejects.toThrow(/cannot send/);
    await expect(createEmailSend(mapKv(), { SEND_EMAIL: { send: ok } as SendEmail })
      .submit(queue as never, email, FROM)).rejects.toThrow(/not enabled/);

    // Same journal, tightened policy: the queued message must not go out.
    const tightened = setup(ok);
    const queued = await tightened.submit(email);
    const rebound = emailActions.bind(
        new ActionJournal<TaggedAction<{ send: SendEmailPayload }>>(tightened.kv, { namespace: "email-send" }),
        { sender: { send: ok } as SendEmail, kv: tightened.kv, policy: { ...POLICY, mailboxPrefix: "other-" } });
    await expect(rebound.apply(queued)).rejects.toThrow(/cannot send/);
    expect(tightened.sent).toEqual([]);
  });
});

describe("hourly send cap", () => {
  it("refuses sends past the cap at apply, however they were approved", async () => {
    const { sent, actions, submit } = setup(ok);
    const first = await submit({ to: manyRecipients(50, "a"), subject: "1", text: "x" });
    const second = await submit({ to: manyRecipients(50, "b"), subject: "2", text: "x" });
    const third = await submit({ to: ["late@example.com"], subject: "3", text: "x" });
    await actions.apply(first);
    await actions.apply(second);
    await expect(actions.apply(third)).rejects.toThrow(/limited to 100 recipients per hour/);
    expect(sent).toHaveLength(2);
  });

  it("refunds the allowance when the binding rejects the message", async () => {
    let reject = true;
    const { sent, actions, submit } = setup(async () => {
      if (reject) throw new Error("destination address not verified");
      return { messageId: "<m@x.com>" };
    });
    const bad1 = await submit({ to: manyRecipients(50, "a"), subject: "1", text: "x" });
    const bad2 = await submit({ to: manyRecipients(50, "b"), subject: "2", text: "x" });
    await actions.apply(bad1).catch(() => {});
    await actions.apply(bad2).catch(() => {});
    reject = false;
    const good = await submit({ to: ["alice@example.com"], subject: "3", text: "x" });
    await actions.apply(good);
    expect(sent).toHaveLength(1);
  });

  it("refuses at submit when the cap is already spent", async () => {
    const kv = mapKv();
    const { actions, queue, submit } = setup(ok, kv);
    const id = await submit({ to: manyRecipients(50, "a"), subject: "1", text: "x" });
    await actions.apply(id);
    await actions.apply(await submit({ to: manyRecipients(50, "b"), subject: "2", text: "x" }));
    const send = createEmailSend(kv, { ...ENV, SEND_EMAIL: { send: ok } as SendEmail });
    await expect(send.submit(queue as never,
        { to: ["one@example.com"], subject: "3", text: "x" }, FROM))
      .rejects.toThrow(/per hour/);
  });

  it("counts survive a new instance over the same storage (Durable Object eviction)", async () => {
    const kv = mapKv();
    checkSendQuota(kv, MAX_RECIPIENTS_PER_HOUR, true, 1_000);
    // A fresh process sees the same ledger.
    expect(() => checkSendQuota(kv, 1, true, 2_000)).toThrow(/per hour/);
  });

  it("frees the allowance as old sends age out of the hour", () => {
    const kv = mapKv();
    checkSendQuota(kv, MAX_RECIPIENTS_PER_HOUR, true, 1_000);
    expect(() => checkSendQuota(kv, 1, true, 1_000 + 3_600_000 - 1)).toThrow();
    checkSendQuota(kv, 1, true, 1_000 + 3_600_000 + 1);
    expect(kv.get<unknown[]>("email-send:quota")).toHaveLength(1);
  });
});

describe("prepareSend", () => {
  const base: OutgoingEmail = { to: ["alice@example.com"], subject: "Hi", text: "x" };
  const attach = (filename: string, mimeType: string): OutgoingEmail => ({
    ...base, attachments: [{ filename, mimeType, content: new ArrayBuffer(1) }],
  });

  it.each<[string, OutgoingEmail, RegExp]>([
    ["no recipients", { ...base, to: [] }, /at least one of to, cc, or bcc/i],
    ["display-name address", { ...base, to: ["Alice <alice@example.com>"] }, /not a plain email/],
    ["control character in address", { ...base, to: ["al\u0000ice@example.com"] }, /not a plain email/],
    ["consecutive dots in address", { ...base, to: ["a..b@example.com"] }, /not a plain email/],
    ["header injection in subject", { ...base, subject: "Hi\r\nBcc: x@evil.com" }, /line breaks/],
    ["control character in subject", { ...base, subject: "Hi\u0000there" }, /control characters/],
    ["header injection in name", { ...base, fromName: "A\nBcc: x@evil.com" }, /line breaks/],
    ["address-like display name", { ...base, fromName: "ceo@bank.com" }, /fromName must not/],
    ["header injection in filename", attach("a\r\nX: y.txt", "text/plain"), /line breaks/],
    ["path in filename", attach("../a.txt", "text/plain"), /filename must not/],
    ["control character in filename", attach("a\u0000.txt", "text/plain"), /filename must not/],
    ["mime with parameters", attach("a.txt", "text/plain; charset=x"), /mimeType must be a plain type/],
    ["multipart mime", attach("a.txt", "multipart/mixed"), /mimeType must be a plain type/],
    ["message mime", attach("a.eml", "message/rfc822"), /mimeType must be a plain type/],
    ["no body", { to: ["alice@example.com"], subject: "Hi" }, /text or html/],
    ["bad Message-ID", { ...base, inReplyTo: "orig@example.com" }, /Message-ID/],
    ["several in-reply-to ids", { ...base, inReplyTo: "<a@x.com> <b@x.com>" }, /a Message-ID/],
    ["control character in Message-ID", { ...base, inReplyTo: "<a\u0000@x.com>" }, /Message-ID/],
    ["too many recipients",
      { ...base, to: Array.from({ length: 51 }, (_, i) => `u${i}@example.com`) }, /At most 50/],
    ["oversized attachments", {
      ...base,
      attachments: [{ filename: "big", mimeType: "application/octet-stream",
        content: new ArrayBuffer(1024 * 1024 + 1) }],
    }, /at most 1048576 bytes/],
    ["a body too large for the approval to show in full",
      { ...base, text: "x".repeat(200 * 1024) }, /too large for its approval/],
  ])("rejects %s", async (_name, email, error) => {
    await expect(prepareSend(email, FROM)).rejects.toThrow(error);
  });

  it("always sends from the bound mailbox", async () => {
    const payload = await prepareSend(
        { ...base, from: "boss@example.com" } as OutgoingEmail, FROM);
    expect(payload.from).toEqual({ name: "", email: FROM });
  });

  it("rejects a References chain over the provider's header limit", async () => {
    const id = (i: number) => `<${String(i).padStart(3, "0")}${"a".repeat(120)}@x.com>`;
    const references = Array.from({ length: 17 }, (_, i) => id(i)).join(" ");
    await expect(prepareSend({ ...base, references }, FROM)).rejects.toThrow(/longer than 2048/);
  });

  it("accepts the same bodies when no attachment metadata has to fit", async () => {
    await expect(prepareSend({ ...base, text: "x".repeat(60 * 1024), html: "y".repeat(34 * 1024) }, FROM))
      .resolves.toBeDefined();
  });

  it("refuses a message whose attachment metadata the approval would drop", async () => {
    // A body that nearly fills the approval budget leaves no room for the attachment fields.
    const email: OutgoingEmail = {
      ...base, text: "x".repeat(60 * 1024), html: "y".repeat(34 * 1024),
      attachments: Array.from({ length: 10 }, (_, i) => ({
        filename: `${"n".repeat(200)}${i}.txt`, mimeType: "text/plain", content: new ArrayBuffer(1),
      })),
    };
    await expect(prepareSend(email, FROM)).rejects.toThrow(/too large for its approval/);
  });

  it("accepts threading ids and normalizes the mime type", async () => {
    const payload = await prepareSend({
      ...attach("a.PDF", "Application/PDF"),
      inReplyTo: "<c@x.com>", references: "<a@x.com>  <b@x.com>",
    }, FROM);
    expect(payload.references).toBe("<a@x.com> <b@x.com>");
    expect(payload.attachments[0]).toMatchObject({ filename: "a.PDF", mimeType: "application/pdf" });
  });
});
