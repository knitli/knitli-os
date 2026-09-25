import { openApiMcpServer } from "@cloudflare/codemode/mcp";
import { createLegacyMcpHandler, WorkerTransport } from "agents/mcp";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { buildNativeOpenApiFacade, type OpenApiPublisherSurface } from "@gadgets/mcp-shared/openapi-publisher";
import { describe, expect, it, vi } from "vitest";
import { handleOpenApiPublisher, publisherVendorIds, PUBLISHER_BODY_BYTES, PUBLISHER_CODE_BYTES } from "../src/openapi-publisher";

declare module "cloudflare:workers" { interface ProvidedEnv { PUBLISHER_TEST_EGRESS: Fetcher; } }

const route = `https://workshop.invalid/api/mcp/${"a".repeat(64)}/1`;
const pending = { status: "pending", actionId: 7, message: "approval" };
function setup(vendorId = "native") {
  const disposed: string[] = [];
  const surface: OpenApiPublisherSurface = { protocol: "native-openapi-facade-v1", defs: {}, tools: [{ name: "send", mode: "action", classifiedBy: "default" }] };
  const session = { describePublisherSurface: vi.fn(async () => surface), callTool: vi.fn(async () => pending), getActionResult: vi.fn(async () => pending), [Symbol.dispose]: () => disposed.push("session") };
  const client = { getCreationSpec: vi.fn(async () => ({ type: "gatekeeper", vendorId })), openSession: vi.fn(async () => session), [Symbol.dispose]: () => disposed.push("client") };
  const gadget = { getGatekeeperById: vi.fn(async () => client), [Symbol.dispose]: () => disposed.push("gadget") };
  const authenticated = { openGadget: vi.fn(async () => gadget) };
  const api = { authenticate: vi.fn(async () => authenticated), authenticateFromCfAccess: vi.fn(async () => authenticated) };
  const factory = vi.fn(() => api as unknown as PublicApi);
  const ctx = createExecutionContext();
  const config = { ...env, OPENAPI_MCP_PUBLISHER_ENABLED: "true", OPENAPI_MCP_PUBLISHER_VENDOR_IDS: '["native"]' };
  const request = (body: string, init: RequestInit = {}) => new Request(route, { method: "POST", headers: { Authorization: "Bearer test:token", "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body, ...init });
  const send = async (message: unknown) => {
    const response = await handleOpenApiPublisher(request(JSON.stringify(message)), config, ctx, factory);
    await waitOnExecutionContext(ctx);
    return response;
  };
  return { config, ctx, factory, api, authenticated, gadget, client, session, surface, disposed, request, send };
}
const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const call = (code: string, name = "execute") => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { code } } });

describe("publisher admission", () => {
  it("PUB-R15 defaults disabled before authentication and rejects invalid config", async () => {
    const s = setup();
    expect((await handleOpenApiPublisher(s.request("{}"), { ...s.config, OPENAPI_MCP_PUBLISHER_ENABLED: undefined }, s.ctx, s.factory)).status).toBe(404);
    expect(s.factory).not.toHaveBeenCalled();
    expect((await handleOpenApiPublisher(s.request("{}"), { ...s.config, OPENAPI_MCP_PUBLISHER_VENDOR_IDS: '["native","native"]' }, s.ctx, s.factory)).status).toBe(503);
    expect(s.factory).not.toHaveBeenCalled();
  });
  it.each(['null', '{}', '["UPPER"]', '["native","native"]', JSON.stringify(Array(1025).fill('x')), ' '.repeat(65537)])("rejects malformed deployment allowlist", value => {
    expect(() => publisherVendorIds(value)).toThrow();
  });
  it("rejects noncanonical route, method and foreign Origin", async () => {
    const s = setup();
    for (const path of [route + '/', route + '?x=1', route.replace('/1', '/01'), route.replace('/1', '/00'), route.replace('a'.repeat(64), 'A'.repeat(64))]) {
      expect((await handleOpenApiPublisher(new Request(path, { method: 'POST', body: '{}' }), s.config, s.ctx, s.factory)).status).toBe(404);
    }
    expect((await handleOpenApiPublisher(new Request(route), s.config, s.ctx, s.factory)).status).toBe(405);
    expect((await handleOpenApiPublisher(s.request('{}', { headers: { Origin: 'https://foreign.invalid' } }), s.config, s.ctx, s.factory)).status).toBe(403);
    expect(s.factory).not.toHaveBeenCalled();
  });
  it("routes a workspace's first connection, workpiece id 0", async () => {
    const s = setup();
    const response = await handleOpenApiPublisher(new Request(route.replace(/\/1$/, '/0'), s.request(JSON.stringify(list))), s.config, s.ctx, s.factory);
    await waitOnExecutionContext(s.ctx);
    expect(response.status).toBe(200);
    expect(s.gadget.getGatekeeperById).toHaveBeenCalledWith(0);
  });
  it("Access mode cannot use bearer as bypass", async () => {
    const s = setup();
    expect((await handleOpenApiPublisher(s.request('{}'), { ...s.config, CF_ACCESS_AUD: 'required' }, s.ctx, s.factory)).status).toBe(403);
    expect(s.factory).not.toHaveBeenCalled();
  });
  it("PUB-R09 caps streamed body and cancels before any capability opens", async () => {
    const s = setup(); const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(PUBLISHER_BODY_BYTES + 1)); }, cancel });
    const response = await handleOpenApiPublisher(s.request('', { body }), s.config, s.ctx, s.factory);
    expect(response.status).toBe(413); expect(cancel).toHaveBeenCalledOnce();
    expect(s.api.authenticate).toHaveBeenCalledWith('test:token');
    expect(s.authenticated.openGadget).not.toHaveBeenCalled();
  });
  it.each(['{', '[]', '[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]', '{}'])("PUB-R09 rejects invalid RPC before capabilities: %s", async body => {
    const s = setup();
    expect((await handleOpenApiPublisher(s.request(body), s.config, s.ctx, s.factory)).status).toBe(400);
    expect(s.authenticated.openGadget).not.toHaveBeenCalled();
  });
  it.each(['plain', 'openapi_installer', 'nativeextra'])("PUB-R14 rejects ineligible vendor %s before session", async vendor => {
    const s = setup(vendor);
    expect((await s.send(list)).status).toBe(403);
    expect(s.client.openSession).not.toHaveBeenCalled(); expect(s.session.describePublisherSurface).not.toHaveBeenCalled();
    expect(s.disposed).toEqual(['client', 'gadget']);
  });
  it.each(['search', 'execute'])("caps UTF-8 %s source before opening capabilities", async name => {
    const s = setup(); expect((await s.send(call('é'.repeat(PUBLISHER_CODE_BYTES / 2 + 1), name))).status).toBe(413);
    expect(s.authenticated.openGadget).not.toHaveBeenCalled();
  });
  it("caps spec without publishing a partial catalog", async () => {
    const s = setup(); s.surface.tools[0].description = 'x'.repeat(2 * 1024 * 1024);
    expect((await s.send(list)).status).toBe(413); expect(s.disposed).toEqual(['session', 'client', 'gadget']);
  });
});

describe("real pinned SDK and Loader", () => {
  it("PUB-R10 initializes stateless JSON and closes exactly once", async () => {
    const s = setup();
    const response = await s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.has('mcp-session-id')).toBe(false); expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(await response.json()).toMatchObject({ result: { serverInfo: { name: 'native-openapi-facade' } } });
    expect(s.disposed).toEqual(['session', 'client', 'gadget']);
  });
  it("PUB-R10 advertises only search and execute", async () => {
    const s = setup(); const response = await s.send(list);
    const result = await response.json() as { result: { tools: { name: string }[] } };
    expect(result.result.tools.map(t => t.name)).toEqual(['search', 'execute']);
  });
  it("PUB-R10 searches the actual facade in a Worker Loader sandbox", async () => {
    const s = setup(); const response = await s.send(call('async () => Object.keys((await codemode.spec()).paths)', 'search'));
    const result = await response.json();
    expect(JSON.stringify(result)).toContain('/operations/73656e64');
    expect(s.session.callTool).not.toHaveBeenCalled();
  });
  it("PUB-R10 preserves pending native envelope through real execute", async () => {
    const s = setup();
    const response = await s.send(call('async () => await codemode.request({method:"POST",path:"/operations/73656e64",body:{},contentType:"application/json"})'));
    const result = await response.json() as { result: { content: { text: string }[] } };
    expect(JSON.parse(result.result.content[0].text)).toEqual(pending);
    expect(s.session.callTool).toHaveBeenCalledWith('send', {});
    expect(s.disposed).toEqual(['session', 'client', 'gadget']);
  });
  it("sandbox has no outbound network or host credentials", async () => {
    const allowed = new DynamicWorkerExecutor({ loader: env.LOADER, globalOutbound: env.PUBLISHER_TEST_EGRESS });
    const control = await allowed.execute('async () => await (await fetch("https://example.invalid")).text()', []);
    expect(JSON.stringify(control)).toContain("EGRESS_ALLOWED");
    const s = setup();
    const response = await s.send(call('async () => { try { await fetch("https://example.invalid"); return "EGRESS_ALLOWED"; } catch { return {denied:true, token:typeof OPENAPI_MCP_PUBLISHER_VENDOR_IDS}; } }'));
    expect(JSON.stringify(await response.json())).toContain('denied'); expect(s.session.callTool).not.toHaveBeenCalled();
  });
});

describe("request-owned callback lifetime", () => {
  it("PUB-R11 drains an admitted callback after abort and refuses subsequent callbacks", async () => {
    const s = setup();
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    s.session.callTool.mockImplementation(async () => { entered(); await gate; return pending; });
    const controller = new AbortController();
    const code = 'async () => { await codemode.request({method:"POST",path:"/operations/73656e64",body:{},contentType:"application/json"}); return await codemode.request({method:"POST",path:"/operations/73656e64",body:{},contentType:"application/json"}); }';
    const response = handleOpenApiPublisher(s.request(JSON.stringify(call(code)), { signal: controller.signal }), s.config, s.ctx, s.factory);
    await started; controller.abort();
    expect((await response).status).toBe(499);
    expect(s.disposed).toEqual([]);
    release(); await waitOnExecutionContext(s.ctx);
    expect(s.session.callTool).toHaveBeenCalledOnce();
    expect(s.disposed).toEqual(['session', 'client', 'gadget']);
  });
  it("PUB-R11 drains fire-and-forget native calls before disposing on normal completion", async () => {
    const s = setup();
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    s.session.callTool.mockImplementation(async () => { entered(); await gate; return pending; });
    const response = handleOpenApiPublisher(s.request(JSON.stringify(call('async () => { codemode.request({method:"POST",path:"/operations/73656e64",body:{},contentType:"application/json"}); await new Promise(r => setTimeout(r, 10)); return "done"; }'))), s.config, s.ctx, s.factory);
    await started;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(s.disposed).toEqual([]);
    release(); expect((await response).status).toBe(200); await waitOnExecutionContext(s.ctx);
    expect(s.disposed).toEqual(['session', 'client', 'gadget']);
  });
});

it("PUB-R11 deadline closes admission while draining admitted calls", async () => {
  const s = setup();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  s.session.callTool.mockImplementation(async () => { entered(); await gate; return pending; });
  vi.useFakeTimers();
  try {
    const response = handleOpenApiPublisher(s.request(JSON.stringify(call('async () => await codemode.request({method:"POST",path:"/operations/73656e64",body:{},contentType:"application/json"})'))), s.config, s.ctx, s.factory);
    await started;
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await response).status).toBe(504); expect(s.disposed).toEqual([]);
    release(); await waitOnExecutionContext(s.ctx);
    expect(s.disposed).toEqual(['session', 'client', 'gadget']);
  } finally { release(); vi.useRealTimers(); }
});

it.each([{ status: 'failed', message: 'failure' }, { status: 'rejected', message: 'rejected' }])("PUB-R12 preserves $status through the pinned SDK", async envelope => {
  const s = setup(); s.session.callTool.mockResolvedValue(envelope as typeof pending);
  const response = await s.send(call('async () => await codemode.request({method:"POST",path:"/operations/73656e64",body:{},contentType:"application/json"})'));
  const result = await response.json() as { result: { content: { text: string }[] } };
  expect(JSON.parse(result.result.content[0].text)).toEqual(envelope);
});

it("real SDK control loses __proto__; host refuses the schema before SDK/provider dispatch", async () => {
  const s = setup();
  s.surface.tools[0].inputSchema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"normal":{"type":"string"}}}');
  const { spec } = buildNativeOpenApiFacade(s.surface);
  const sdk = openApiMcpServer({ spec, executor: new DynamicWorkerExecutor({ loader: env.LOADER, globalOutbound: null }), request: async () => { throw new Error('Unexpected provider dispatch'); } });
  const transport = new WorkerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const handle = createLegacyMcpHandler(sdk, { route: new URL(route).pathname, transport });
  try {
    const response = await handle(s.request(JSON.stringify(call('async () => Object.keys((await codemode.spec()).paths["/operations/73656e64"].post.requestBody.content["application/json"].schema.properties)', 'search'))), env, s.ctx);
    const result = await response.json() as { result: { content: { text: string }[] } };
    expect(JSON.parse(result.result.content[0].text)).toEqual(['normal']);
  } finally { await sdk.close(); }
  const refused = await s.send(list);
  expect(refused.status).toBe(422);
  expect(JSON.stringify(await refused.json())).toContain('does not support __proto__');
  expect(s.session.callTool).not.toHaveBeenCalled();
  expect(s.disposed).toEqual(['session', 'client', 'gadget']);
});

it("PUB-R11 executor settlement refuses late callbacks while earlier calls still drain", async () => {
  const s = setup();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  s.session.callTool.mockImplementation(async () => { await gate; return pending; });
  let settled!: () => void; const executionDone = new Promise<void>(resolve => { settled = resolve; });
  let callback!: (...args: unknown[]) => Promise<unknown>;
  const realExecute = DynamicWorkerExecutor.prototype.execute;
  const observed = vi.spyOn(DynamicWorkerExecutor.prototype, 'execute').mockImplementation(async function(code, providers, options) {
    if (Array.isArray(providers)) callback = providers[0].fns.request;
    const result = await realExecute.call(this, code, providers, options);
    settled(); return result;
  });
  try {
    const response = handleOpenApiPublisher(s.request(JSON.stringify(call('async () => { codemode.request({method:"POST",path:"/operations/73656e64",body:{},contentType:"application/json"}); await new Promise(r => setTimeout(r, 10)); return "done"; }'))), s.config, s.ctx, s.factory);
    await executionDone;
    // Let the real execute return through the host wrapper's finally, while the native call
    // remains blocked and the request owner's cleanup cannot yet close/dispose anything.
    await Promise.resolve();
    expect(observed).toHaveBeenCalledOnce(); expect(s.disposed).toEqual([]);
    expect(() => callback({ method: 'POST', path: '/operations/73656e64', body: {}, contentType: 'application/json' })).toThrow('Publisher request closed.');
    expect(s.session.callTool).toHaveBeenCalledOnce();
    release(); expect((await response).status).toBe(200); await waitOnExecutionContext(s.ctx);
    expect(s.disposed).toEqual(['session', 'client', 'gadget']);
  } finally { release(); observed.mockRestore(); }
});

describe("PR34 whole-request budget and response correlation", () => {
  it.each(['deadline', 'abort', 'hanging-cancel'] as const)("bounds a never-ending small body on %s and cancels its reader", async reason => {
    const s = setup(); const cancelled = vi.fn(() => reason === 'hanging-cancel' ? new Promise<void>(() => {}) : undefined); const abort = new AbortController();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let reading!: () => void; const started = new Promise<void>(resolve => { reading = resolve; });
    const body = new ReadableStream<Uint8Array>({ start(c) { stream = c; c.enqueue(new TextEncoder().encode('{')); }, pull() { reading(); }, cancel: cancelled });
    vi.useFakeTimers();
    let completed: Response | undefined;
    const response = handleOpenApiPublisher(s.request('', { body, signal: abort.signal }), s.config, s.ctx, s.factory).then(value => { completed = value; return value; });
    try {
      await started; await vi.advanceTimersByTimeAsync(0);
      if (reason !== 'abort') await vi.advanceTimersByTimeAsync(60_000);
      else { abort.abort(); await vi.advanceTimersByTimeAsync(0); }
      expect(completed?.status).toBe(reason !== 'abort' ? 504 : 499);
      expect(cancelled).toHaveBeenCalledOnce();
      expect(s.authenticated.openGadget).not.toHaveBeenCalled();
      await waitOnExecutionContext(s.ctx);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (!cancelled.mock.calls.length) stream.close();
      await response; await waitOnExecutionContext(s.ctx); vi.useRealTimers();
    }
  });
  it("does not authenticate an already aborted request", async () => {
    const s = setup(); const controller = new AbortController(); controller.abort();
    const response = await handleOpenApiPublisher(s.request(JSON.stringify(list), { signal: controller.signal }), s.config, s.ctx, s.factory);
    expect(response.status).toBe(499); expect(s.factory).not.toHaveBeenCalled();
    await waitOnExecutionContext(s.ctx);
  });
  it("deadline covers authentication and blocks late authentication from opening a gadget", async () => {
    const s = setup(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    s.api.authenticate.mockImplementation(async () => { entered(); await gate; return s.authenticated; });
    vi.useFakeTimers(); let completed: Response | undefined;
    const response = handleOpenApiPublisher(s.request(JSON.stringify(list)), s.config, s.ctx, s.factory).then(value => { completed = value; return value; });
    try {
      await started; await vi.advanceTimersByTimeAsync(60_000);
      expect(completed?.status).toBe(504); expect(vi.getTimerCount()).toBe(0);
      release(); await waitOnExecutionContext(s.ctx);
      expect(s.authenticated.openGadget).not.toHaveBeenCalled();
    } finally { release(); await response; await waitOnExecutionContext(s.ctx); vi.useRealTimers(); }
  });
  it.each([0, '', 'request-correlation'])("echoes exact valid ID %j on code, spec and native failures", async id => {
    const code = setup();
    const oversized = await code.send({ ...call('x'.repeat(PUBLISHER_CODE_BYTES + 1)), id });
    expect(oversized.status).toBe(413); expect(await oversized.json()).toMatchObject({ id, error: { code: -32602 } });
    const spec = setup(); spec.surface.tools[0].description = 'x'.repeat(2 * 1024 * 1024);
    const large = await spec.send({ ...list, id });
    expect(large.status).toBe(413); expect(await large.json()).toMatchObject({ id, error: { code: -32603 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const native = setup(); native.authenticated.openGadget.mockRejectedValue(new Error('No such gatekeeper id: 7'));
    const unavailable = await native.send({ ...list, id });
    expect(unavailable.status).toBe(403); expect(await unavailable.json()).toMatchObject({ id, error: { code: -32603, message: "Publisher connection unavailable." } });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "publisher.native.failed", error: expect.stringContaining("No such gatekeeper id: 7") }));
    warn.mockRestore();
  });
  it("does not send JSON-RPC errors for valid notifications", async () => {
    for (const failure of ['code', 'spec', 'native']) {
      const s = setup();
      if (failure === 'spec') s.surface.tools[0].description = 'x'.repeat(2 * 1024 * 1024);
      if (failure === 'native') s.authenticated.openGadget.mockRejectedValue(new Error('unavailable'));
      const message = failure === 'code' ? call('x'.repeat(PUBLISHER_CODE_BYTES + 1)) : list;
      const { id: _id, ...notification } = message;
      const response = await s.send(notification);
      expect(await response.text()).toBe('');
    }
  });
  it.each([{ ...list, id: null }, { ...list, id: true }, { ...list, id: {} }, { jsonrpc: '2.0', id: 'not-a-request', result: {} }])("invalid envelope has null ID before native capabilities", async message => {
    const s = setup(); const response = await s.send(message);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ id: null, error: { code: -32600 } });
    expect(s.authenticated.openGadget).not.toHaveBeenCalled();
  });
});

it("PR34 late session after deadline is disposed without catalog or provider access", async () => {
  const s = setup(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  s.client.openSession.mockImplementation(async () => { entered(); await gate; return s.session; });
  vi.useFakeTimers();
  const response = handleOpenApiPublisher(s.request(JSON.stringify(list)), s.config, s.ctx, s.factory);
  try {
    await started; await vi.advanceTimersByTimeAsync(60_000);
    expect((await response).status).toBe(504); expect(vi.getTimerCount()).toBe(0);
    expect(s.disposed).toEqual([]);
    release(); await waitOnExecutionContext(s.ctx);
    expect(s.session.describePublisherSurface).not.toHaveBeenCalled();
    expect(s.session.callTool).not.toHaveBeenCalled();
    expect(s.disposed).toEqual(['session', 'client', 'gadget']);
  } finally { release(); await response; await waitOnExecutionContext(s.ctx); vi.useRealTimers(); }
});

it("PR34 early authentication and parse errors release the request timer", async () => {
  vi.useFakeTimers();
  try {
    const auth = setup(); auth.api.authenticate.mockRejectedValue(new Error('bad credential'));
    expect((await auth.send(list)).status).toBe(403); expect(vi.getTimerCount()).toBe(0);
    const parse = setup();
    const response = await handleOpenApiPublisher(parse.request('{'), parse.config, parse.ctx, parse.factory);
    expect(await response.json()).toMatchObject({ id: null, error: { code: -32700 } });
    await waitOnExecutionContext(parse.ctx); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
