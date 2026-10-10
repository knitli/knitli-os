// Outbound mail (ported from michielappelman/cloudflare-os 162f9d7, Apache-2.0, with a durable
// hourly cap and stricter validation): validation of a Gadget's `send()` request, the
// approval-backed "send" action, and delivery through the Worker's `send_email` binding once the
// user approves it.

import {
  ActionApplyError,
  ActionJournal,
  defineActions,
  type ActionSubmitter,
  type ActionPresentation,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import type { OutgoingEmail } from "../types";

/** Recipients across To, Cc and Bcc, per message. */
export const MAX_RECIPIENTS = 50;
/**
 * Recipients that may be sent to per rolling hour from one binding, however the sends were approved.
 * Auto-approval ("always allow") must not turn a runaway agent into a mail flood.
 */
export const MAX_RECIPIENTS_PER_HOUR = 100;
const HOUR_MS = 60 * 60 * 1000;
/**
 * Total attachment bytes. The pending send is stored as one Durable Object KV value until it is
 * approved, and a value is capped at 2 MiB.
 */
export const MAX_ATTACHMENT_BYTES = 1024 * 1024;
/** Well under the send_email binding's 32. */
const MAX_ATTACHMENTS = 10;
const MAX_SUBJECT_LENGTH = 998;
const MAX_BODY_BYTES = 512 * 1024;

/** The action kind auto-approval rules key on: "always allow sending from this mailbox". */
export const SEND_EMAIL_ACTION: ActionKind = { tag: "send-email", label: "Send email" };

/** A validated send, as stored in the action journal until it is approved. */
export type SendEmailPayload = {
  from: { name: string; email: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string | null;
  html: string | null;
  replyTo: string | null;
  inReplyTo: string | null;
  references: string | null;
  attachments: { filename: string; mimeType: string; content: ArrayBuffer; sha256: string }[];
};

type Kv = ConstructorParameters<typeof ActionJournal>[0] & {
  put(key: string, value: unknown): void;
};

/** What the action needs at apply time. */
export type SendEmailHost = { sender: SendEmail | undefined; kv: Kv; policy: SendPolicy };

/**
 * Deployment-controlled limits on who may be impersonated. Mailbox names are claimed first come,
 * first served by any user, so an unrestricted binding would let a user send as `admin@` on the
 * deployment's verified domain. Sending therefore stays off until the administrator names the
 * domain and the mailbox-name prefix that users' sender addresses must carry.
 */
export type SendPolicy = { domain?: string; mailboxPrefix?: string };

/** Throws unless `from` is inside the administrator-approved sender namespace. */
export function assertMayDeliverFrom(from: string, policy: SendPolicy): void {
  let domain = policy.domain?.trim().toLowerCase();
  let prefix = policy.mailboxPrefix?.trim().toLowerCase();
  if (!domain || !prefix) {
    throw new ActionApplyError("Sending email is not enabled on this deployment: the administrator " +
        "must set EMAIL_DOMAIN and EMAIL_SEND_PREFIX.");
  }
  let at = from.lastIndexOf("@");
  if (from.slice(at + 1).toLowerCase() !== domain || !from.slice(0, at).toLowerCase().startsWith(prefix)) {
    throw new ActionApplyError(`This mailbox cannot send email: only addresses at ${domain} ` +
        `starting with "${prefix}" may send.`);
  }
}

// Deliberately strict: a bare ASCII addr-spec (RFC 5322 atext local part, LDH domain), no display
// name, comments, whitespace or control characters, so the approver sees exactly the address the
// mail goes to.
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
// A Message-ID as it appears in headers: `<local@domain>` in printable ASCII, never several at once.
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]+@[\x21-\x3b\x3d\x3f-\x7e]+>$/;
const MAX_REFERENCES = 20;
// The send_email binding rejects any custom header value over 2,048 bytes.
const MAX_HEADER_VALUE = 2048;
// Only top-level types a mail client treats as a plain file; multipart/message would nest MIME.
const MIME_TYPE = /^(?:application|audio|font|image|text|video)\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const CONTROL = /\p{Cc}/u;
const encoder = new TextEncoder();

function isAddress(value: string): boolean {
  let at = value.lastIndexOf("@");
  return at > 0 && at <= 64 && value.length <= 254 &&
      LOCAL_PART.test(value.slice(0, at)) && DOMAIN.test(value.slice(at + 1));
}

function addresses(field: string, value: string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of addresses.`);
  return value.map(address => {
    if (typeof address !== "string" || !isAddress(address.trim())) {
      throw new Error(`${field}: ${JSON.stringify(address)} is not a plain email address ` +
          `such as "name@example.com".`);
    }
    return address.trim();
  });
}

function messageIds(field: string, value: string | undefined, max: number): string | null {
  if (value === undefined || value.trim() === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  let ids = value.trim().split(/\s+/);
  if (ids.length > max || !ids.every(id => id.length <= 255 && MESSAGE_ID.test(id))) {
    throw new Error(`${field} must be ${max === 1 ? "a Message-ID" : "Message-IDs"} such as ` +
        `"<abc@example.com>"${max === 1 ? "" : ` (at most ${max})`}.`);
  }
  return ids.join(" ");
}

function singleLine(field: string, value: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  if (/[\r\n]/.test(value)) throw new Error(`${field} must not contain line breaks.`);
  if (CONTROL.test(value)) throw new Error(`${field} must not contain control characters.`);
  if (value.length > max) throw new Error(`${field} is longer than ${max} characters.`);
  return value;
}

function body(field: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  if (encoder.encode(value).byteLength > MAX_BODY_BYTES) {
    throw new Error(`${field} is larger than ${MAX_BODY_BYTES} bytes.`);
  }
  return value;
}

function base64(bytes: ArrayBuffer): string {
  let view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  let digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validates a Gadget's send request into the payload the approver reviews and apply sends.
 * @param email The Gadget's request.
 * @param from The bound mailbox's address, always the sender.
 */
export async function prepareSend(
    email: OutgoingEmail, from: string): Promise<SendEmailPayload> {
  let to = addresses("to", email.to);
  let cc = addresses("cc", email.cc);
  let bcc = addresses("bcc", email.bcc);
  let recipients = to.length + cc.length + bcc.length;
  if (recipients === 0) throw new Error("At least one of to, cc, or bcc must name a recipient.");
  if (recipients > MAX_RECIPIENTS) {
    throw new Error(`At most ${MAX_RECIPIENTS} recipients are allowed per message.`);
  }
  let subject = singleLine("subject", email.subject, MAX_SUBJECT_LENGTH);
  let text = body("text", email.text);
  let html = body("html", email.html);
  if (text === null && html === null) throw new Error("Provide a text or html body.");
  let replyTo = email.replyTo === undefined ? null : addresses("replyTo", [email.replyTo])[0]!;
  let fromName = singleLine("fromName", (email.fromName ?? "").trim(), 100);
  // A display name is the one free-form part of From; keep it from posing as an address.
  if (/[<>@"\\]/.test(fromName) || CONTROL.test(fromName)) {
    throw new Error(`fromName must not contain < > @ " \\ or control characters.`);
  }
  let inReplyTo = messageIds("inReplyTo", email.inReplyTo, 1);
  let references = messageIds("references", email.references, MAX_REFERENCES) ?? inReplyTo;
  if (references !== null && references.length > MAX_HEADER_VALUE) {
    throw new Error(`references is longer than ${MAX_HEADER_VALUE} characters; drop the oldest ids.`);
  }

  let total = 0;
  let attachments: SendEmailPayload["attachments"] = [];
  if ((email.attachments?.length ?? 0) > MAX_ATTACHMENTS) {
    throw new Error(`At most ${MAX_ATTACHMENTS} attachments are allowed per message.`);
  }
  for (let attachment of email.attachments ?? []) {
    if (!(attachment.content instanceof ArrayBuffer)) {
      throw new Error("Attachment content must be an ArrayBuffer.");
    }
    let filename = singleLine("Attachment filename", attachment.filename?.trim() ?? "", 255);
    if (!filename) throw new Error("Every attachment needs a filename.");
    if (CONTROL.test(filename) || /[/\\"]/.test(filename)) {
      throw new Error(`Attachment filename must not contain / \\ " or control characters.`);
    }
    let mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim().toLowerCase() : "";
    if (!MIME_TYPE.test(mimeType)) {
      throw new Error(`Attachment ${filename}: mimeType must be a plain type such as ` +
          `"application/pdf" (no parameters; not multipart or message).`);
    }
    total += attachment.content.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachments may total at most ${MAX_ATTACHMENT_BYTES} bytes.`);
    }
    // Copied so later changes by the caller cannot alter what was approved.
    let content = attachment.content.slice(0);
    attachments.push({ filename, mimeType, content, sha256: await sha256Hex(content) });
  }

  let payload = {
    from: { name: fromName, email: from },
    to, cc, bcc, subject, text, html, replyTo, inReplyTo, references, attachments,
  };
  if (!approvalShowsEverything(payload)) {
    throw new Error("The message is too large for its approval to show in full; shorten it.");
  }
  return payload;
}

// Every field, attachment metadata included, must be shown in full, or the approval would not say
// what is sent -- and "always allow" sends unseen. `descriptionIsComplete` is unusable here: it is
// never set when attachments are present, because their contents are opaque to the approver.
function approvalShowsEverything(payload: SendEmailPayload): boolean {
  let { fields = [], description } = describeSend(payload);
  return !fields.some(field => field.truncated) && !/fields? omitted/.test(description) &&
      fields.filter(field => field.kind === "file").length === payload.attachments.length;
}

function describeSend(payload: SendEmailPayload): ActionPresentation {
  let recipients = [...payload.to, ...payload.cc, ...payload.bcc];
  let builder = buildDescription(
      `Send an email from ${payload.from.email} to ${recipients.length} ` +
      `recipient${recipients.length === 1 ? "" : "s"}.`);
  builder.inline("From", payload.from.name
      ? `${payload.from.name} <${payload.from.email}>` : payload.from.email);
  if (payload.to.length) builder.list("To", payload.to);
  if (payload.cc.length) builder.list("Cc", payload.cc);
  if (payload.bcc.length) builder.list("Bcc", payload.bcc);
  if (payload.replyTo) builder.inline("Reply-To", payload.replyTo);
  builder.inline("Subject", payload.subject);
  if (payload.inReplyTo) builder.inline("In-Reply-To", payload.inReplyTo);
  if (payload.references) builder.inline("References", payload.references);
  // Fields are shown literally (never rendered), so an HTML body appears as its source.
  if (payload.text !== null) builder.verbatim("Text body", payload.text);
  if (payload.html !== null) builder.verbatim("HTML body", payload.html, "html");
  for (let attachment of payload.attachments) {
    builder.file("Attachment", {
      name: attachment.filename,
      mediaType: attachment.mimeType,
      size: attachment.content.byteLength,
      sha256: attachment.sha256,
      origin: "agent",
    });
  }
  let firstRecipient = recipients[0]!;
  let others = recipients.length > 1 ? ` (+${recipients.length - 1})` : "";
  return {
    title: sanitizeTitle(`Email ${firstRecipient}${others}: ${payload.subject || "(no subject)"}`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

const QUOTA_KEY = "email-send:quota";
export type QuotaEntry = { at: number; recipients: number };

function recentSends(kv: Kv, now: number): QuotaEntry[] {
  return (kv.get<QuotaEntry[]>(QUOTA_KEY) ?? []).filter(entry => entry.at > now - HOUR_MS);
}

/**
 * Checks the hourly cap for `recipients` more, and records them when `charge` is set. The ledger is
 * Durable Object storage, so it survives eviction; with no await between read and write, charging
 * is atomic. Throws when the cap would be exceeded.
 */
export function checkSendQuota(
    kv: Kv, recipients: number, charge: boolean, now = Date.now()): QuotaEntry | undefined {
  let recent = recentSends(kv, now);
  let used = recent.reduce((sum, entry) => sum + entry.recipients, 0);
  if (used + recipients > MAX_RECIPIENTS_PER_HOUR) {
    throw new ActionApplyError(`Sending is limited to ${MAX_RECIPIENTS_PER_HOUR} recipients per ` +
        `hour from one mailbox (${used} used). Try again later.`);
  }
  if (!charge) return undefined;
  let entry = { at: now, recipients };
  kv.put(QUOTA_KEY, [...recent, entry]);
  return entry;
}

/** Gives back a charge for a send known not to have gone out. */
export function refundSendQuota(kv: Kv, entry: QuotaEntry, now = Date.now()): void {
  let recent = recentSends(kv, now);
  let index = recent.findIndex(e => e.at === entry.at && e.recipients === entry.recipients);
  if (index >= 0) recent.splice(index, 1);
  kv.put(QUOTA_KEY, recent);
}

// Codes the email service documents as "try again later" / "temporarily unavailable".
const TRANSIENT = ["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR"];

function isTransient(error: unknown): boolean {
  let code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSIENT.includes(code);
}

async function deliver(payload: SendEmailPayload, host: SendEmailHost): Promise<void> {
  if (!host.sender) {
    throw new ActionApplyError(
        "This deployment has no send_email binding (SEND_EMAIL), so it cannot send email.");
  }
  // Re-checked here: the policy may have changed since the message was queued.
  assertMayDeliverFrom(payload.from.email, host.policy);
  // Charged before dispatch, so a crash mid-send still counts; refunded below when the binding
  // reports a rejection.
  let charge = checkSendQuota(host.kv,
      payload.to.length + payload.cc.length + payload.bcc.length, true)!;
  let headers: Record<string, string> = {};
  if (payload.inReplyTo) headers["In-Reply-To"] = payload.inReplyTo;
  if (payload.references) headers["References"] = payload.references;
  let message = {
    from: payload.from.name ? payload.from : payload.from.email,
    subject: payload.subject,
    ...(payload.to.length ? { to: payload.to } : {}),
    ...(payload.cc.length ? { cc: payload.cc } : {}),
    ...(payload.bcc.length ? { bcc: payload.bcc } : {}),
    ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
    ...(payload.text !== null ? { text: payload.text } : {}),
    ...(payload.html !== null ? { html: payload.html } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(payload.attachments.length ? {
      attachments: payload.attachments.map(a => ({
        disposition: "attachment" as const,
        filename: a.filename,
        type: a.mimeType,
        // Base64, which the local simulator can serialize (it cannot take binary content).
        content: base64(a.content),
      })),
    } : {}),
  } as EmailMessageBuilder;
  try {
    await host.sender.send(message);
  } catch (error) {
    // The binding rejects before handing the message off (unverified destination, sender not
    // allowed, malformed message), so a thrown send is known not to have been delivered.
    refundSendQuota(host.kv, charge);
    // Retryable rather than terminal: the service says to try again, and nothing was sent.
    if (isTransient(error)) throw error;
    throw new ActionApplyError(
        `Sending failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const emailActions = defineActions<SendEmailHost, { send: SendEmailPayload }>({
  send: {
    kind: SEND_EMAIL_ACTION,
    // Only advertises the kind: the user still has to enable the per-binding rule.
    autoApprovable: true,
    // Nothing reads sent mail back, so there is no simulated state for the agent to continue on.
    delivery: "await-decision",
    // Sending is irreversible: never replay it after a crash mid-send.
    claimBeforeApply: true,
    describe: describeSend,
    apply: deliver,
  },
}, {
  // No external credential: the binding and the mailbox's ownership don't change under a pending
  // action.
  fence: "none",
  vendorId: "email",
});

/**
 * The gatekeeper's send machinery, bound to its Durable Object storage and `send_email` binding.
 * @param kv The gatekeeper Durable Object's `ctx.storage.kv`.
 * @param env The `SEND_EMAIL` binding (absent on a deployment without one) and the administrator's
 *   sender namespace.
 */
export function createEmailSend(kv: Kv,
    env: { SEND_EMAIL?: SendEmail; EMAIL_DOMAIN?: string; EMAIL_SEND_PREFIX?: string }) {
  let policy: SendPolicy = { domain: env.EMAIL_DOMAIN, mailboxPrefix: env.EMAIL_SEND_PREFIX };
  let actions = emailActions.bind(
      new ActionJournal<TaggedAction<{ send: SendEmailPayload }>>(kv, { namespace: "email-send" }),
      { sender: env.SEND_EMAIL, kv, policy });
  return {
    /** Action kinds the user may choose to always allow. */
    autoApprovableKinds: () => actions.autoApprovableKinds(),
    apply: (id: number) => actions.apply(id),
    reject: (id: number) => actions.reject(id),
    /** Validates and queues a send from `from`; resolves once queued. */
    async submit(queue: ActionSubmitter, email: OutgoingEmail, from: string): Promise<void> {
      assertMayDeliverFrom(from, policy);
      let payload = await prepareSend(email, from);
      checkSendQuota(kv, payload.to.length + payload.cc.length + payload.bcc.length, false);
      await actions.submit(queue, "send", payload);
    },
  };
}

/** A gatekeeper's send machinery; see `createEmailSend`. */
export type EmailSend = ReturnType<typeof createEmailSend>;
