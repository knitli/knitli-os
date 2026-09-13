import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { AdminApi, AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { parseAdminConfig } from "../src/admin-config.js";
import { ADMIN_CONFIG_KEY } from "../src/blueprint-archive.js";

const HASH = new Uint8Array([1, 2, 3]);
const ORIGIN = "https://graph.microsoft.com";
const MAIL = `${ORIGIN}/#segment=mail`;
const CALENDAR = `${ORIGIN}/#segment=calendar`;
const CUSTOM = `${ORIGIN}/#tool=*`;
const NARROWED_MAIL = `${ORIGIN}/#segment=mail&revision=${"a".repeat(64)}&tool=me.ListMessages`;
const CUSTOM_URL = `${ORIGIN}/#tool=me.sendMail`;

type Call = { vendorId: string; method: string; args: unknown[] };
type Control = { reset(): Promise<void>; getCalls(): Promise<Call[]>; setRefiningResolverAdvertised(value: boolean): Promise<void> };
const control = (env as unknown as { ADMIN_GATEKEEPER_CONTROL: Fetcher<Control> }).ADMIN_GATEKEEPER_CONTROL;
let publicApi: RpcStub<PublicApi>;
let adminSession: RpcStub<AuthenticatedApi>;
let admin: RpcStub<AdminApi>;

async function connect() {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", { headers: { Upgrade: "websocket" } }));
  if (!response.webSocket) throw new Error("Expected WebSocket.");
  response.webSocket.accept();
  return newWebSocketRpcSession<PublicApi>(response.webSocket);
}

async function user(prefix: string) {
  const name = prefix + crypto.randomUUID().replaceAll("-", "");
  const token = await publicApi.createAccount(name, name, HASH);
  if (!token) throw new Error("Expected account token.");
  return publicApi.authenticate(token);
}

async function request(input: { resourceUrl?: string }) {
  using session = await user("refining");
  using workspace = await session.newGadget();
  const metadata = await workspace.getMetadata();
  const stub = exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(metadata.id));
  return runInDurableObject(stub, async instance => {
    const impl = (instance as unknown as { impl: { requestConnection(chatId: number, value: object): Promise<unknown>; consumeCapturedConnectionRequests(chatId: number): unknown[] } }).impl;
    const result = await impl.requestConnection(1, { vendorId: "refining", reason: "fixture", bindingName: "mail", ...input });
    return { result, cards: impl.consumeCapturedConnectionRequests(1) };
  });
}

beforeAll(async () => {
  publicApi = await connect();
  const token = await publicApi.createAccount("aibridgeadmin", "aibridgeadmin", HASH);
  if (!token) throw new Error("Expected admin token.");
  adminSession = publicApi.authenticate(token);
  const capability = await adminSession.getAdminApi();
  if (!capability) throw new Error("Expected admin capability.");
  admin = capability;
});

beforeEach(async () => {
  await control.reset();
  await admin.setResourceEnabled("refining", MAIL, true);
  await admin.setResourceEnabled("refining", CALENDAR, true);
  await admin.setResourceEnabled("refining", CUSTOM, true);
});

afterAll(() => { admin?.[Symbol.dispose](); adminSession?.[Symbol.dispose](); publicApi?.[Symbol.dispose](); });

describe("connection request resource resolution", () => {
  it("H-SUBSET-001 captures raw narrowed URLs with their bare host-owned pattern", async () => {
    const actual = await request({ resourceUrl: NARROWED_MAIL }) as { result: { requested: boolean }; cards: Array<Record<string, unknown>> };
    expect(actual.result.requested).toBe(true);
    expect(actual.cards).toHaveLength(1);
    expect(actual.cards[0]).toMatchObject({ type: "connectionRequest", vendorId: "refining", resourceUrl: NARROWED_MAIL, resourceUrlPattern: MAIL, resourceTitle: "Mail", reason: "fixture", bindingName: "mail" });
    const calls = await control.getCalls();
    expect(calls.filter(call => call.method === "resolveResourceUrl")).toHaveLength(1);
    expect(calls.filter(call => call.method === "connectAccount" || call.method === "createAccount")).toEqual([]);
  });

  it("H-SUBSET-002 rejects outside, stale, wrong-member, malformed, and unadvertised URLs without a card", async () => {
    for (const resourceUrl of ["https://outside.invalid/#segment=mail", `${ORIGIN}/#segment=mail&revision=${"b".repeat(64)}&tool=me.ListMessages`, `${ORIGIN}/#segment=calendar&revision=${"a".repeat(64)}&tool=me.ListMessages`, `${ORIGIN}/#segment=mail&revision=${"a".repeat(64)}&tool=me.ListMessages&extra=x`, "fixture:unadvertised"]) {
      const actual = await request({ resourceUrl }) as { result: { requested: boolean }; cards: unknown[] };
      expect(actual.result.requested).toBe(false);
      expect(actual.cards).toEqual([]);
    }
  });

  it("H-SUBSET-003 exact-maps only currently enabled resources and cannot sole-resource widen", async () => {
    await admin.setResourceEnabled("refining", CALENDAR, false);
    await admin.setResourceEnabled("refining", CUSTOM, false);
    expect(parseAdminConfig(await env.BLUEPRINTS.get(ADMIN_CONFIG_KEY))).toMatchObject({ enabledResources: { refining: [MAIL] } });
    const mail = await request({ resourceUrl: NARROWED_MAIL }) as { result: { requested: boolean }; cards: unknown[] };
    expect(mail.result.requested).toBe(true);
    expect(mail.cards).toEqual([expect.objectContaining({ resourceUrl: NARROWED_MAIL, resourceUrlPattern: MAIL, resourceTitle: "Mail" })]);
    const custom = await request({ resourceUrl: CUSTOM_URL }) as { result: { requested: boolean }; cards: unknown[] };
    expect(custom.result.requested).toBe(false);
    expect(custom.cards).toEqual([]);
    const outside = await request({ resourceUrl: "https://outside.invalid/" }) as { result: { requested: boolean }; cards: unknown[] };
    expect(outside.result.requested).toBe(false);
    expect(outside.cards).toEqual([]);
  });

  it("H-SUBSET-004 retains the ordinary picker ambiguity without a concrete URL", async () => {
    const actual = await request({}) as { result: { requested: boolean; message: string }; cards: unknown[] };
    expect(actual.result.requested).toBe(false);
    expect(actual.cards).toEqual([]);
    expect(actual.result.message).toBe('Cannot request a connection for "Refining fixture": this vendor offers multiple resource types and has no whole-instance ("https://*") option, so a resourceUrl is required to identify which one. Call listConnectableResources to see the patterns, then retry with a resourceUrl matching one of:\n  * Mail — urlPattern: https://graph.microsoft.com/#segment=mail\n  * Calendar — urlPattern: https://graph.microsoft.com/#segment=calendar\n  * Custom — urlPattern: https://graph.microsoft.com/#tool=*');
    expect((await control.getCalls()).filter(call => call.method === "resolveResourceUrl")).toEqual([]);
  });

  it("H-SUBSET-005 retains generic behavior for a freshly non-advertising vendor", async () => {
    await control.setRefiningResolverAdvertised(false);
    const success = await request({ resourceUrl: MAIL }) as { result: { requested: boolean; message: string }; cards: unknown[] };
    expect(success.result.requested).toBe(true);
    expect(success.cards).toHaveLength(1);
    expect(success.result.message).toBe(
      'Connection request sent to the user for "Refining fixture". Awaiting their decision; ' +
      'your turn will end now. If they accept, you\'ll be resumed with access to the resource; ' +
      'if they deny, your turn stays ended until the user messages you.',
    );
    const mismatch = await request({ resourceUrl: "https://outside.invalid/#segment=mail" }) as { result: { requested: boolean; message: string }; cards: unknown[] };
    expect(mismatch.result.requested).toBe(false);
    expect(mismatch.cards).toEqual([]);
    expect(mismatch.result.message).toBe(
      'Cannot request a connection for "Refining fixture": resourceUrl ' +
      '"https://outside.invalid/#segment=mail" does not match any resource type this vendor offers, ' +
      'and the vendor has no whole-instance ("https://*") option. Call listConnectableResources to ' +
      'see the patterns, then retry with a resourceUrl matching one of:\n' +
      '  * Mail — urlPattern: https://graph.microsoft.com/#segment=mail\n' +
      '  * Calendar — urlPattern: https://graph.microsoft.com/#segment=calendar\n' +
      '  * Custom — urlPattern: https://graph.microsoft.com/#tool=*',
    );
    expect((await control.getCalls()).filter(call => call.method === "resolveResourceUrl")).toEqual([]);
  });

  it("H-SUBSET-010 denies resolver failures without logging URL or thrown details", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const actual = await request({ resourceUrl: "fixture:throw" }) as { result: { requested: boolean }; cards: unknown[] };
      expect(actual.result.requested).toBe(false);
      expect(actual.cards).toEqual([]);
      const event = warn.mock.calls.find(call => JSON.stringify(call).includes("gatekeeper.resource.resolve.failed"));
      expect(event).toBeDefined();
      const serialized = JSON.stringify(event);
      expect(serialized).toContain('"event":"gatekeeper.resource.resolve.failed"');
      expect(serialized).toContain('"vendorId":"refining"');
      expect(serialized).toContain('"operation":"connector-resolver"');
      expect(event).toEqual([{ component: "workshop.user", event: "gatekeeper.resource.resolve.failed", vendorId: "refining", operation: "connector-resolver", message: "gatekeeper resource resolution failed" }]);
      for (const forbidden of ["REFINING_RESOLVER_SENTINEL", NARROWED_MAIL, "error", "cause", "stack"]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("H-SUBSET-009 uses a fresh description when the cached list predates resolver support", async () => {
    await admin.setResourceEnabled("refining", CALENDAR, false);
    await admin.setResourceEnabled("refining", CUSTOM, false);
    await control.setRefiningResolverAdvertised(false);
    using session = await user("stale");
    using workspace = await session.newGadget();
    const metadata = await workspace.getMetadata();
    const stub = exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(metadata.id));
    await runInDurableObject(stub, async instance => {
      const impl = (instance as unknown as { impl: { listConnectableResources(id: string): Promise<string>; requestConnection(chatId: number, value: object): Promise<{ requested: boolean }>; consumeCapturedConnectionRequests(chatId: number): unknown[] } }).impl;
      await impl.listConnectableResources("refining");
      await control.setRefiningResolverAdvertised(true);
      const describeBeforeRequest = (await control.getCalls()).filter(call => call.method === "describe").length;
      const result = await impl.requestConnection(1, { vendorId: "refining", resourceUrl: "https://outside.invalid/#segment=mail", reason: "fixture", bindingName: "mail" });
      expect(result.requested).toBe(false);
      expect(impl.consumeCapturedConnectionRequests(1)).toEqual([]);
      expect((await control.getCalls()).filter(call => call.method === "describe").length).toBe(describeBeforeRequest + 1);
    });
    const calls = await control.getCalls();
    expect(calls.filter(call => call.method === "resolveResourceUrl")).toHaveLength(1);
  });
});
