import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env, exports, RpcTarget } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";
import server from "../src/server";

const route = `https://workshop.invalid/api/mcp/${"a".repeat(64)}/1`;
const config = { ...env, OPENAPI_MCP_PUBLISHER_ENABLED: "true", OPENAPI_MCP_PUBLISHER_VENDOR_IDS: '["native"]' };
function request(headers: HeadersInit = {}) {
  // Invalid JSON is an observable checkpoint AFTER successful authentication, before capabilities.
  return new Request(route, { method: "POST", headers, body: "{" });
}
afterEach(() => { vi.restoreAllMocks(); });

it("PUB-R07 authenticates a real Workshop token and rejects it after revocation", async () => {
  const name = `pub${crypto.randomUUID().replaceAll('-', '')}`;
  const user = exports.UserDurableObject.getByName(name);
  const secret = await user.createAccount(name, name, new Uint8Array([1, 2, 3]));
  expect(secret).toBeTypeOf('string');
  const headers = { Authorization: `Bearer ${name}:${secret}` };
  expect((await server.fetch(request(headers), config, createExecutionContext())).status).toBe(400);
  await runInDurableObject(user, async (_instance, ctx) => { await ctx.storage.deleteAll(); });
  expect((await server.fetch(request(headers), config, createExecutionContext())).status).toBe(403);
});

it("PUB-R07 verifies a signed Access JWT/email without Origin and never falls back to bearer", async () => {
  const issuer = `https://publisher-${crypto.randomUUID()}.cloudflareaccess.com`;
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(publicKey), kid: 'publisher-test', alg: 'RS256', use: 'sig' };
  const certFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    expect(String(input)).toBe(`${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  });
  const accessConfig = { ...config, CF_ACCESS_ISS: issuer, CF_ACCESS_AUD: 'publisher-aud' };
  const email = `publisher-${crypto.randomUUID()}@example.invalid`;
  const jwt = await new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'publisher-test' }).setIssuer(issuer).setAudience('publisher-aud').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  expect((await server.fetch(request({ 'cf-access-jwt-assertion': jwt }), accessConfig, createExecutionContext())).status).toBe(400);
  expect(certFetch).toHaveBeenCalledOnce();
  // Authentication uses the verified email to create/address the existing native User DO.
  expect(await exports.UserDurableObject.getByName(email).authenticateFromCfAccess(email, false)).toBe(false);
  expect((await server.fetch(request({ Authorization: 'Bearer irrelevant:token' }), accessConfig, createExecutionContext())).status).toBe(403);
  const wrongAudience = await new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'publisher-test' }).setIssuer(issuer).setAudience('wrong-aud').setExpirationTime('5m').sign(privateKey);
  expect((await server.fetch(request({ 'cf-access-jwt-assertion': wrongAudience }), accessConfig, createExecutionContext())).status).toBe(403);
  const missingEmail = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'publisher-test' }).setIssuer(issuer).setAudience('publisher-aud').setExpirationTime('5m').sign(privateKey);
  expect((await server.fetch(request({ 'cf-access-jwt-assertion': missingEmail }), accessConfig, createExecutionContext())).status).toBe(403);
  expect((await server.fetch(request({ 'cf-access-jwt-assertion': jwt, Origin: 'https://foreign.invalid' }), accessConfig, createExecutionContext())).status).toBe(403);
});

// Only the provider facet is a fixture: User, Overseer, connection client, readiness checks,
// native RPC crossing, selected-session ownership and pinned SDK are real.
class PublisherFixtureSession extends RpcTarget {
  async describePublisherSurface() { return { protocol: 'native-openapi-facade-v1', tools: [], defs: {} }; }
  async callTool() { return { status: 'rejected', message: 'fixture' }; }
  async getActionResult() { return { status: 'rejected', message: 'fixture' }; }
}

it("PUB-R08 real workspace owner reaches SDK; wrong owner and initializing connection cannot open session", async () => {
  const name = `pubowner${crypto.randomUUID().replaceAll('-', '')}`;
  const user = exports.UserDurableObject.getByName(name);
  const secret = await user.createAccount(name, name, new Uint8Array([1, 2, 3]));
  const otherName = `pubother${crypto.randomUUID().replaceAll('-', '')}`;
  const other = exports.UserDurableObject.getByName(otherName);
  const otherSecret = await other.createAccount(otherName, otherName, new Uint8Array([1, 2, 3]));
  const id = exports.OverseerDurableObject.newUniqueId();
  const workspace = exports.OverseerDurableObject.get(id);
  await user.newGadget(id.toString(), 'Publisher fixture');
  // Initialize normally through existing owner authorization.
  using opened = await workspace.open(user.id.toString(), name, () => {});
  let sessions = 0;
  await runInDurableObject(workspace, async instance => {
    const impl = (instance as unknown as { impl: any }).impl;
    impl.storage.gatekeepers.put({ id: 1, resourceTitle: 'Publisher fixture', class: {}, creationSpec: { type: 'gatekeeper', vendorId: 'native', resourceUrl: 'https://provider.invalid', typeUrlPattern: 'https://*' } });
    impl.getGatekeeperFacet = () => ({ startSession: async () => { sessions++; return new PublisherFixtureSession(); } });
  });
  const send = (token: string, gatekeeper = 1) => server.fetch(new Request(`https://workshop.invalid/api/mcp/${id}/${gatekeeper}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }), config, createExecutionContext());
  const valid = await send(`${name}:${secret}`);
  expect(valid.status).toBe(200); expect(JSON.stringify(await valid.json())).toContain('search'); expect(sessions).toBe(1);
  expect((await send(`${otherName}:${otherSecret}`)).status).toBe(403); expect(sessions).toBe(1);
  // A real existing share must not bypass the native owner-only workspace policy.
  expect(await opened.addCollaborator(otherName, 'use')).not.toBeNull();
  expect((await opened.listCollaborators()).some(c => c.profile.id === otherName)).toBe(true);
  await runInDurableObject(workspace, async instance => {
    const impl = (instance as unknown as { impl: any }).impl;
    const record = impl.storage.gatekeepers.get(1); record.ownerOnly = true; impl.storage.gatekeepers.put(record);
  });
  await expect(workspace.open(other.id.toString(), otherName, () => {})).rejects.toMatchObject({ code: 'WORKSPACE_ACCESS_DENIED' });
  expect((await send(`${otherName}:${otherSecret}`)).status).toBe(403); expect(sessions).toBe(1);
  expect((await send(`${name}:${secret}`, 2)).status).toBe(403); expect(sessions).toBe(1);
  await runInDurableObject(workspace, async instance => {
    const impl = (instance as unknown as { impl: any }).impl;
    const record = impl.storage.gatekeepers.get(1); record.initializing = true; impl.storage.gatekeepers.put(record);
  });
  expect((await send(`${name}:${secret}`)).status).toBe(403); expect(sessions).toBe(1);
  await runInDurableObject(workspace, async instance => {
    const impl = (instance as unknown as { impl: any }).impl;
    const record = impl.storage.gatekeepers.get(1); delete record.initializing; impl.storage.gatekeepers.put(record);
    const leave = impl.joinSession('use');
    try {
      const restart = vi.fn(); impl.scheduleAccessRestart = restart;
      impl.storage.gadgets.put({ type: 'gadget', id: 100, title: 'G', created: new Date(0), bindingName: 'G', bindings: {} });
      impl.bindWorkpiece(100, 'NATIVE', 1);
      expect(restart).toHaveBeenCalledOnce();
      expect(() => impl.assertGatekeeperUsable(1)).toThrow(/restarting/);
    } finally { leave(); }
  });
  expect((await send(`${name}:${secret}`)).status).toBe(403); expect(sessions).toBe(1);
});
