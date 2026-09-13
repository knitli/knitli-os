import { env, exports } from 'cloudflare:workers';
import { newWebSocketRpcSession, type RpcStub, type RpcTarget } from 'capnweb';
import type { AdminApi, AuthenticatedApi, PublicApi } from '@gadgets/workshop-shared/api';
import type { GatekeeperVendor } from '@gadgets/workshop-shared/gatekeeper';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { AdminGatekeeperApps } from '../src/fork/admin-gatekeeper-apps.js';
import { ADMIN_CONFIG_KEY } from '../src/blueprint-archive.js';
import { MAX_ADMIN_CONFIG_BYTES, MAX_ADMIN_RESOURCE_URL_PATTERN_BYTES, MAX_ENABLED_RESOURCES_PER_VENDOR } from '../src/admin-settings.js';

type Call = { vendorId: string; method: string; args: unknown[] };
interface Control { reset(): Promise<void>; getCalls(): Promise<Call[]> }
interface FrameUi extends RpcTarget { ping(): Promise<string> }
const control = (env as unknown as { ADMIN_GATEKEEPER_CONTROL: Fetcher<Control> }).ADMIN_GATEKEEPER_CONTROL;
const hash = new Uint8Array([1, 2, 3]);
let publicApi: RpcStub<PublicApi>;
let adminSession: RpcStub<AuthenticatedApi>;
let userSession: RpcStub<AuthenticatedApi>;
let admin: RpcStub<AdminApi>;

async function connect() {
  const response = await exports.default.fetch(new Request('https://workshop.invalid/api', { headers: { Upgrade: 'websocket' } }));
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error('Expected WebSocket.');
  response.webSocket.accept();
  return newWebSocketRpcSession<PublicApi>(response.webSocket);
}
async function authenticate(username: string) {
  const token = await publicApi.createAccount(username, username, hash);
  if (!token) throw new Error('Expected account token.');
  return publicApi.authenticate(token);
}
beforeAll(async () => {
  publicApi = await connect();
  adminSession = await authenticate('aibridgeadmin');
  userSession = await authenticate('frameuser');
  const capability = await adminSession.getAdminApi();
  if (!capability) throw new Error('Expected admin capability.');
  admin = capability;
});
beforeEach(async () => { await control.reset(); });
afterAll(() => { admin?.[Symbol.dispose](); userSession?.[Symbol.dispose](); adminSession?.[Symbol.dispose](); publicApi?.[Symbol.dispose](); });

describe('admin gatekeeper frames', () => {
  it('B-HOST-010 contains vendor rejection details while retaining operation diagnostics', async () => {
    const sentinel = 'SENTINEL_VENDOR_TOKEN';
    const describeError = Object.assign(new Error(sentinel, { cause: sentinel }), { arbitrary: sentinel });
    describeError.stack = sentinel;
    const listVendor = { describe: async () => { throw describeError; } } as unknown as Service<GatekeeperVendor>;
    const openVendor = {
      describe: async () => ({ providesAdminUi: { title: 'fixture' } }),
      startAdminUi: async () => { throw sentinel; },
    } as unknown as Service<GatekeeperVendor>;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(new AdminGatekeeperApps(new Map([['list-fixture', listVendor]])).list()).resolves.toEqual([]);
      await expect(new AdminGatekeeperApps(new Map([['open-fixture', openVendor]])).open('open-fixture')).resolves.toBeNull();
      expect(warn.mock.calls).toEqual(expect.arrayContaining([
        expect.arrayContaining([expect.objectContaining({
          component: 'workshop.admin.gatekeeper-apps', event: 'gatekeeper.admin.describe.failed', vendorId: 'list-fixture', operation: 'describe',
          error: 'Gatekeeper vendor call rejected (Error).',
        })]),
        expect.arrayContaining([expect.objectContaining({
          component: 'workshop.admin.gatekeeper-apps', event: 'gatekeeper.admin.open.failed', vendorId: 'open-fixture', operation: 'startAdminUi',
          error: 'Gatekeeper vendor call rejected (string).',
        })]),
      ]));
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('arbitrary');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('cause');
      for (const [fields] of warn.mock.calls) expect(fields).not.toHaveProperty('errorStack');
    } finally {
      warn.mockRestore();
    }
  });

  it('B-HOST-011 enforces bounded resource persistence and preserves recovery paths', async () => {
    const settings = exports.AdminSettings.getByName(`resource-policy-${crypto.randomUUID()}`);
    const priorKv = await env.BLUEPRINTS.get(ADMIN_CONFIG_KEY);
    const snapshot = async () => ({ config: await settings.getAdminConfig(), kv: await env.BLUEPRINTS.get(ADMIN_CONFIG_KEY) });
    const unchangedAfterReject = async (before: Awaited<ReturnType<typeof snapshot>>, call: () => Promise<void>, message: string) => {
      const pending = (async () => await call())();
      void pending.catch(() => undefined); // Cap'n Web reports rejected futures independently.
      await expect(pending).rejects.toThrow(message);
      expect(await snapshot()).toEqual(before);
    };
    const patterns = (count: number, prefix = 'https://fixture.invalid/r') =>
      Array.from({ length: count }, (_, i) => `${prefix}${i}`);
    const oversizedPatterns = (vendor: string) =>
      patterns(MAX_ENABLED_RESOURCES_PER_VENDOR, `https://fixture.invalid/${vendor}/${'x'.repeat(1000)}-`);
    try {
      await settings.updateAdminConfig({ enabledResources: {} });
      let multibyte = `https://fixture.invalid/${'é'.repeat(1100)}`;
      expect(multibyte.length).toBeLessThan(MAX_ADMIN_RESOURCE_URL_PATTERN_BYTES);
      expect(new TextEncoder().encode(multibyte).byteLength).toBeGreaterThan(MAX_ADMIN_RESOURCE_URL_PATTERN_BYTES);
      expect(() => new URLPattern(multibyte)).not.toThrow();
      let before = await snapshot();
      await unchangedAfterReject(before, () => settings.setResourceEnabled('adminframe', multibyte, true), 'too long');
      before = await snapshot();
      await unchangedAfterReject(before, () => settings.setResourceEnabled('adminframe', 'not a URL pattern [', true), 'invalid');
      await settings.setResourceEnabled('adminframe', 'custom://fixture/allowed', true);
      await settings.setResourceEnabled('adminframe', 'https://fixture.invalid/allowed', true);
      let usable = await snapshot();
      expect(usable.config.enabledResources.adminframe).toEqual([
        'custom://fixture/allowed', 'https://fixture.invalid/allowed',
      ]);
      expect(usable.kv).toBe(JSON.stringify(usable.config));

      await settings.updateAdminConfig({ enabledResources: { adminframe: patterns(MAX_ENABLED_RESOURCES_PER_VENDOR) } });
      before = await snapshot();
      await unchangedAfterReject(before, () => settings.setResourceEnabled('adminframe', 'https://fixture.invalid/129', true), 'Too many');
      await settings.setResourceEnabled('adminframe', patterns(MAX_ENABLED_RESOURCES_PER_VENDOR)[0]!, true);
      expect(await snapshot()).toEqual(before);

      await settings.updateAdminConfig({ enabledResources: { adminframe: ['https://fixture.invalid/idempotent'] } });
      await settings.setResourceEnabled('adminframe', 'https://fixture.invalid/idempotent', true);
      before = await snapshot();
      await unchangedAfterReject(before, () => settings.setResourceEnabled('missing-vendor', 'https://fixture.invalid/new', true), 'Unknown');

      await settings.updateAdminConfig({
        enabledResources: {
          adminframe: ['https://fixture.invalid/legacy'],
          legacyOne: oversizedPatterns('one'), legacyTwo: oversizedPatterns('two'),
          stale: ['https://fixture.invalid/stale'],
        },
      });
      before = await snapshot();
      expect(new TextEncoder().encode(JSON.stringify(before.config)).byteLength).toBeGreaterThan(MAX_ADMIN_CONFIG_BYTES);
      await settings.setResourceEnabled('adminframe', 'https://fixture.invalid/legacy', true);
      expect(await snapshot()).toEqual(before);
      await unchangedAfterReject(before, () => settings.setResourceEnabled('adminframe', 'https://fixture.invalid/new', true), 'too large');
      await settings.setResourceEnabled('stale', 'https://fixture.invalid/stale', false);
      let afterStale = await snapshot();
      expect(afterStale.config.enabledResources.stale).toBeUndefined();
      expect(afterStale.config.enabledResources.adminframe).toEqual(['https://fixture.invalid/legacy']);
      expect(afterStale.kv).toBe(JSON.stringify(afterStale.config));
      await settings.setResourceEnabled('adminframe', 'https://fixture.invalid/legacy', false);
      let afterRecovery = await snapshot();
      expect(afterRecovery.config.enabledResources.adminframe).toBeUndefined();
      expect(afterRecovery.config.enabledResources.legacyOne).toEqual(oversizedPatterns('one'));
      expect(afterRecovery.kv).toBe(JSON.stringify(afterRecovery.config));

      await settings.updateAdminConfig({ enabledResources: Object.fromEntries([
        ['__proto__', ['__proto__', 'https://fixture.invalid/proto', 'too-large-' + 'x'.repeat(MAX_ADMIN_RESOURCE_URL_PATTERN_BYTES)]],
        ['adminframe', ['https://fixture.invalid/keep']],
      ]) });
      await settings.setResourceEnabled('__proto__', 'https://fixture.invalid/proto', false);
      let afterProto = await snapshot();
      expect(afterProto.config.enabledResources.__proto__).toEqual(['__proto__', 'too-large-' + 'x'.repeat(MAX_ADMIN_RESOURCE_URL_PATTERN_BYTES)]);
      expect(afterProto.config.enabledResources.adminframe).toEqual(['https://fixture.invalid/keep']);
      expect(afterProto.kv).toBe(JSON.stringify(afterProto.config));
      await settings.setResourceEnabled('__proto__', 'too-large-' + 'x'.repeat(MAX_ADMIN_RESOURCE_URL_PATTERN_BYTES), false);
      afterProto = await snapshot();
      expect(afterProto.config.enabledResources.__proto__).toEqual(['__proto__']);
      expect(afterProto.config.enabledResources.adminframe).toEqual(['https://fixture.invalid/keep']);
      expect(afterProto.kv).toBe(JSON.stringify(afterProto.config));
      await settings.setResourceEnabled('__proto__', '__proto__', false);
      let final = await settings.getAdminConfig();
      expect(Object.hasOwn(final.enabledResources, '__proto__')).toBe(false);
      expect(final.enabledResources.adminframe).toEqual(['https://fixture.invalid/keep']);
      expect(await env.BLUEPRINTS.get(ADMIN_CONFIG_KEY)).toBe(JSON.stringify(final));
    } finally {
      if (priorKv === null) await env.BLUEPRINTS.delete(ADMIN_CONFIG_KEY);
      else await env.BLUEPRINTS.put(ADMIN_CONFIG_KEY, priorKv);
    }
  });

  it('B-HOST-001 opens an advertised frame without an account', async () => {
    await expect(admin.listGatekeeperAdminApps()).resolves.toEqual([{ id: 'adminframe', title: 'OpenAPI segments', icon: undefined }]);
    const frame = await admin.getGatekeeperAdminApp('adminframe');
    expect(frame).not.toBeNull();
    try {
      const calls = await control.getCalls();
      expect(calls).toContainEqual({ vendorId: 'adminframe', method: 'startAdminUi', args: [{ isAdmin: true }] });
      expect(calls.filter((call) => call.method === 'connectAccount' || call.method === 'createAccount')).toEqual([]);
    } finally {
      frame?.ui[Symbol.dispose]();
    }
  });

  it('B-HOST-002 mints no AdminApi for a normal authenticated user', async () => {
    const userAdmin = await userSession.getAdminApi();
    try {
      if (userAdmin) {
        await userAdmin.listGatekeeperAdminApps();
        const frame = await userAdmin.getGatekeeperAdminApp('adminframe');
        frame?.ui[Symbol.dispose]();
      }
      expect(userAdmin).toBeNull();
      expect(await control.getCalls()).toEqual([]);
    } finally {
      userAdmin?.[Symbol.dispose]();
    }
  });

  it('B-HOST-003 honors the advertised discriminator and missing IDs', async () => {
    expect((await admin.listGatekeeperAdminApps()).map((app) => app.id)).toEqual(['adminframe']);
    await expect(admin.getGatekeeperAdminApp('plain')).resolves.toBeNull();
    await expect(admin.getGatekeeperAdminApp('missing')).resolves.toBeNull();
    expect((await control.getCalls()).filter((call) => call.method === 'startAdminUi')).toEqual([]);
  });

  it('B-HOST-004 preserves the frame capability across the admin RPC hops', async () => {
    const frame = await admin.getGatekeeperAdminApp('adminframe');
    if (!frame) throw new Error('Expected frame.');
    try {
      await expect((frame.ui as RpcStub<FrameUi>).ping()).resolves.toBe('admin-frame-ready');
    } finally {
      frame.ui[Symbol.dispose]();
    }
  });
});
