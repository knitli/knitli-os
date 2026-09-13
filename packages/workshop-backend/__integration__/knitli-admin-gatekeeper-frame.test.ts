import { env, exports } from 'cloudflare:workers';
import { newWebSocketRpcSession, type RpcStub, type RpcTarget } from 'capnweb';
import type { AdminApi, AuthenticatedApi, PublicApi } from '@gadgets/workshop-shared/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
