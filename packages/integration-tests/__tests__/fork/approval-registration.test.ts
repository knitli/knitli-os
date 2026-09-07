// Real authenticated API, User/Overseer DOs, native queue RPC and durable Worker reload.
import type { AuthenticatedApi, ConnectedAccountsSubscriber, Overseer } from "@gadgets/workshop-shared/api";
import type { EnsureActionRegistrationV1, ActionRegistrationReceiptV1 } from "@gadgets/workshop-shared/fork/approval-registration";
import type { RpcStub } from "capnweb";
import { beforeAll, afterAll, expect, it } from "vitest";
import { type Harness, startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID } from "../../src/harness.js";
import { GATEKEEPER_RELOAD_MAIN, WORKSHOP_RELOAD_MAIN, reloadHarnessWorkers } from "../../src/fork/reload-harness.js";
import { NetworkInterceptor } from "../../src/network-interceptor.js";
import { accountLabel, RpcTarget, connect, signUp, logIn, nextUsernames, listConnectedAccounts, stubFor, waitFor } from "../../src/rpc-client.js";
const ORIGIN = "https://openapi-test.example";
interface SelectionUi extends RpcTarget { select(): Promise<{ resourceUrl: string }>; }
interface RegistrationSession extends RpcTarget {
  registerApproval(request: EnsureActionRegistrationV1, loseResponse?: boolean, loseBeforeCommit?: boolean): Promise<ActionRegistrationReceiptV1>;
}
let harness: Harness, interceptor: NetworkInterceptor;
beforeAll(async () => {
  interceptor = new NetworkInterceptor(); interceptor.install();
  harness = await startHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR, patch(config) {
      config.main = GATEKEEPER_RELOAD_MAIN;
      config.vars = { ...config.vars, OPENAPI_HOST_BINDING_TEST: "1", OPENAPI_TEST_ORIGIN: ORIGIN };
    } }],
    patchWorkshop(config) { config.main = WORKSHOP_RELOAD_MAIN; config.vars = { ...config.vars, PUBLIC_BASE_URL: ORIGIN }; },
  });
});
afterAll(async () => {
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close(); interceptor.uninstall(); interceptor.reset();
  expect(unmocked).toEqual([]);
});
async function account(api: RpcStub<AuthenticatedApi>) {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const found = await waitFor("OpenAPI account", async () => (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
  let pattern: string | undefined, ready!: () => void;
  const settled = new Promise<void>(resolve => { ready = resolve; });
  class Subscriber extends RpcTarget implements ConnectedAccountsSubscriber {
    add(...[id, , , resources]: Parameters<ConnectedAccountsSubscriber["add"]>) { if (id === found.id) pattern = resources[0]?.urlPattern; }
    remove() {} ready() { ready(); }
  }
  using subscriber = stubFor(new Subscriber());
  using _subscription = await api.subscribeConnectedAccounts(subscriber); await settled;
  if (!pattern) throw new Error("Missing fixture pattern");
  return { id: found.id, pattern, label: accountLabel(found) };
}
async function add(workspace: RpcStub<Overseer>, acct: { id: number; pattern: string }) {
  const frame = await workspace.startBoundResourceConfigurator(acct.id, acct.pattern);
  using ui = frame.ui as unknown as RpcStub<SelectionUi>;
  const selected = await ui.select();
  const connection = await workspace.newGatekeeper(acct.id, selected.resourceUrl);
  if (!connection) throw new Error("Fixture connection absent");
  return connection;
}
async function request(description = 'Tenant: "test"\nRecord: "42"'): Promise<EnsureActionRegistrationV1> {
  const presentationTemplateDigest = `sha256:${"a".repeat(64)}`;
  const safeDescription = { title: "Update record", description, implementsRevert: false as const, awaitDecision: true as const };
  const bytes = JSON.stringify(["knitli-approval-description", 1, presentationTemplateDigest, safeDescription.title, description, false, true]);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes)));
  return { actionId: 1, safeDescription, presentationTemplateDigest, safeDescriptionDigest: `sha256:${Array.from(hash, b => b.toString(16).padStart(2, "0")).join("")}` };
}
it("recovers a lost response, races fresh native queues, and preserves the exact row across Worker restart", async () => {
  const username = nextUsernames("approvalrestart")[0];
  const value = await request(); let workspaceId: string, gatekeeperId: number, receipt: ActionRegistrationReceiptV1;
  {
    using publicApi = connect(harness.url); using api = await signUp(publicApi, username);
    const acct = await account(api); using workspace = await api.newGadget();
    workspaceId = (await workspace.getMetadata()).id;
    using connection = await add(workspace, acct); gatekeeperId = await connection.getId();
    using first = await connection.openSession() as RpcStub<RegistrationSession>;
    using second = await connection.openSession() as RpcStub<RegistrationSession>;
    await expect(first.registerApproval(value, false, true)).rejects.toThrow("LostResponseBeforeCommit");
    expect((await workspace.listActions()).entries).toHaveLength(0);
    await expect(first.registerApproval(value, true)).rejects.toThrow("LostResponse");
    const results = await Promise.all([first.registerApproval(value), second.registerApproval(value)]);
    receipt = results[0]; expect(results[1]).toEqual(receipt);
    const rows = (await workspace.listActions()).entries;
    expect(rows).toHaveLength(1); expect(rows[0].id).toBe(receipt.registrationId);
    expect(rows[0].description).toEqual(value.safeDescription); expect(rows[0].state).toBe("pending");
    const effects = await harness.fetchWorker(TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/action-state", { method: "POST", body: JSON.stringify({ label: acct.label }) });
    expect(effects.status).toBe(200);
    expect((await effects.json() as { applyCount: number }).applyCount).toBe(0);
    await expect(second.registerApproval(await request("Changed tenant"))).rejects.toThrow("ApprovalRegistrationConflict");
    expect((await workspace.listActions()).entries).toHaveLength(1);
  }
  await reloadHarnessWorkers(harness, [TEST_GATEKEEPER_WORKER]);
  {
    using publicApi = connect(harness.url); using api = await logIn(publicApi, username);
    using workspace = await api.openGadget(workspaceId!);
    using connection = await workspace.getGatekeeperById(gatekeeperId!);
    using session = await connection!.openSession() as RpcStub<RegistrationSession>;
    await expect(session.registerApproval(value)).resolves.toEqual(receipt!);
    let rows = (await workspace.listActions()).entries;
    expect(rows).toHaveLength(1); expect(rows[0].description).toEqual(value.safeDescription); expect(rows[0].state).toBe("pending");
    await workspace.rejectAction(receipt!.registrationId);
    await expect(session.registerApproval(value)).resolves.toEqual(receipt!);
    rows = (await workspace.listActions()).entries;
    expect(rows).toHaveLength(1); expect(rows[0].state).toBe("rejected");
    await connection!.remove();
    await expect(session.registerApproval({ ...value, actionId: 2 })).rejects.toThrow("The execution context which hosts this callback is no longer running.");
    expect((await workspace.listActions()).entries).toHaveLength(1);
  }
});
it("scopes action 1 to each Gatekeeper and each workspace", async () => {
  using publicApi = connect(harness.url); using api = await signUp(publicApi, nextUsernames("approvalscope")[0]);
  const acct = await account(api), value = await request();
  using workspace = await api.newGadget(); using otherWorkspace = await api.newGadget();
  using one = await add(workspace, acct); using two = await add(workspace, acct); using other = await add(otherWorkspace, acct);
  using first = await one.openSession() as RpcStub<RegistrationSession>;
  using duplicate = await one.openSession() as RpcStub<RegistrationSession>;
  using second = await two.openSession() as RpcStub<RegistrationSession>;
  using third = await other.openSession() as RpcStub<RegistrationSession>;
  const concurrent = await Promise.all([first.registerApproval(value), duplicate.registerApproval(value)]);
  expect(concurrent[0]).toEqual(concurrent[1]);
  expect((await workspace.listActions()).entries).toHaveLength(1);
  const a = concurrent[0], b = await second.registerApproval(value);
  expect(a.registrationId).not.toBe(b.registrationId);
  await third.registerApproval(value);
  expect((await workspace.listActions()).entries).toHaveLength(2);
  expect((await otherWorkspace.listActions()).entries).toHaveLength(1);
});
