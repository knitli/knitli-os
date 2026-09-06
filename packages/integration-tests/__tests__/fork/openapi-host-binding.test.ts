// Authenticated host acceptance: real /api RPC, User/Overseer DOs and a private fixture finalizer.
// The fixture simulates admitted dispatch leases; it performs no provider HTTP.
import type { AuthenticatedApi, ConnectedAccountsSubscriber, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import type { DraftReference } from "@gadgets/workshop-shared/fork/openapi-host-binding";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID } from "../../src/harness.js";
import { NetworkInterceptor } from "../../src/network-interceptor.js";
import { accountLabel, type ConnectedAccount, RpcTarget, connect, listConnectedAccounts, logIn, nextUsernames, signUp, stubFor, waitFor } from "../../src/rpc-client.js";

const ORIGIN = "https://openapi-test.example";
const PATTERN = `${ORIGIN}/gatekeeper/openapi/apis/*/releases/*/grants/*`;
type SelectionResult = { reference: DraftReference; resourceUrl: string; expiresAt: number };
interface SelectionUi extends RpcTarget {
  select(options?: { apiId?: string; releaseId?: string; selectionDigest?: string }): Promise<SelectionResult>;
  cancel(): Promise<void>;
}
interface ReadSession extends RpcTarget { readValue(): Promise<number>; }
type Event = { event: string; draftId: string; workspaceId: string; gatekeeperId: number; generation: number };
let harness: Harness;
let interceptor: NetworkInterceptor;

beforeAll(async () => {
  interceptor = new NetworkInterceptor();
  interceptor.install();
  harness = await startHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR, patch(config) {
      config.vars = { ...config.vars, OPENAPI_HOST_BINDING_TEST: "1", OPENAPI_TEST_ORIGIN: ORIGIN };
    } }, {
      binding: "OTHER", dir: TEST_GATEKEEPER_DIR, patch(config) {
        config.name = "gatekeeper-test-other";
        config.vars = { ...config.vars, OPENAPI_HOST_BINDING_TEST: "1", OPENAPI_TEST_ORIGIN: ORIGIN };
      },
    }, {
      binding: "LEGACY", dir: TEST_GATEKEEPER_DIR, patch(config) {
        config.name = "gatekeeper-test-legacy";
      },
    }],
    patchWorkshop(config) { config.vars = { ...config.vars, PUBLIC_BASE_URL: ORIGIN }; },
  });
});
afterAll(async () => {
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close();
  interceptor.uninstall();
  interceptor.reset();
  expect(unmocked).toEqual([]);
});
async function withSession(body: (api: RpcStub<PublicApi>) => Promise<void>) {
  using api = connect(harness.url);
  await body(api);
}
type Account = ConnectedAccount & { pattern: string };
async function provision(api: RpcStub<AuthenticatedApi>, vendorId = TEST_VENDOR_ID): Promise<Account> {
  await api.provisionAmbientAccount(vendorId);
  const account = await waitFor("OpenAPI account", async () => (await listConnectedAccounts(api)).find(a => a.vendorId === vendorId) ?? null);
  let pattern: string | undefined;
  let settle!: () => void;
  const ready = new Promise<void>(resolve => { settle = resolve; });
  class Subscriber extends RpcTarget implements ConnectedAccountsSubscriber {
    add(...[id, , , resources]: Parameters<ConnectedAccountsSubscriber["add"]>) {
      if (id === account.id) pattern = resources[0]?.urlPattern;
    }
    remove() {}
    ready() { settle(); }
  }
  using subscriber = stubFor(new Subscriber());
  using _subscription = await api.subscribeConnectedAccounts(subscriber);
  await ready;
  if (!pattern) throw new Error("Provisioned fixture account did not advertise a resource pattern");
  return { ...account, pattern };
}
async function select(workspace: RpcStub<Overseer>, account: Account) {
  expect(account.pattern).toBe(PATTERN);
  const frame = await workspace.startBoundResourceConfigurator(account.id, account.pattern).catch(error => { throw new Error("startBoundResourceConfigurator: " + String(error)); });
  expect(Object.keys(frame).toSorted()).toEqual(["iframeHtml", "ui"]);
  const ui = frame.ui as unknown as RpcStub<SelectionUi>;
  const selection = await ui.select().catch(error => { throw new Error("selection.select: " + String(error)); });
  expect(Object.keys(selection).toSorted()).toEqual(["expiresAt", "reference", "resourceUrl"]);
  expect(Object.keys(selection.reference).toSorted()).toEqual(["draftId", "grantId", "selectionDigest"]);
  expect(selection.resourceUrl).toBe(`${ORIGIN}/gatekeeper/openapi/apis/test-api/releases/test-release/grants/${selection.reference.grantId}`);
  return { ui, selection };
}
// Convert unexpected successful Add into plain evidence so Vitest cannot accidentally invoke
// an RPC stub while formatting a failed .rejects assertion; dispose that unexpected capability.
async function attemptAdd(workspace: RpcStub<Overseer>, accountId: number, resourceUrl: string) {
  using connection = await workspace.newGatekeeper(accountId, resourceUrl);
  return { gatekeeperId: connection ? await connection.getId() : null };
}
async function control(action: string, input: object, worker = TEST_GATEKEEPER_WORKER) {
  return harness.fetchWorker(worker, `http://gatekeeper-test.test/control/${action}`, { method: "POST", body: JSON.stringify(input) });
}
async function command(action: string, input: object) {
  const response = await control(action, input);
  expect(response.status, await response.text()).toBe(204);
}
async function events(draftId: string): Promise<Event[]> {
  const response = await control("readBindingEvents", { draftId });
  expect(response.status).toBe(200);
  return ((await response.json()) as { events: Event[] }).events;
}
async function arrived(kind: string, draftId: string) {
  await waitFor(`${kind} barrier`, async () => {
    const response = await control("barrier-arrivals", { key: `openapi:${kind}:${draftId}` });
    expect(response.status).toBe(200);
    return ((await response.json()) as { arrivals: number }).arrivals > 0 ? true : null;
  });
}
let reloadRevision = 0;
async function reloadWorkers() {
  const revision = String(++reloadRevision);
  await harness.server.update(options => ({ ...options, workers: options.workers.map(worker => {
    if (!("config" in worker)) throw new Error("Expected inline local Worker config");
    return { config: { ...worker.config, vars: { ...worker.config.vars, OPENAPI_ACCEPTANCE_RELOAD: revision } } };
  }) }));
}
async function noActivation(draftId: string) {
  expect((await events(draftId)).filter(e => e.event === "activated" || e.event === "dispatch-admitted")).toEqual([]);
}

describe("authenticated OpenAPI host binding", () => {
  it("rejects malformed fixture RPC arguments without changing the draft or dispatch lifecycle", async () => withSession(async publicApi => {
    using api = await signUp(publicApi, nextUsernames("bindingvalidation")[0]);
    const account = await provision(api);
    using workspace = await api.newGadget();
    const frame = await workspace.startBoundResourceConfigurator(account.id, account.pattern);
    using ui = frame.ui as unknown as RpcStub<SelectionUi>;
    // The string would pass Selection's manual property checks and create a draft without validation.
    const malformedOptions = "unexpected" as unknown as Parameters<SelectionUi["select"]>[0];
    await expect(Promise.resolve(ui.select(malformedOptions))).rejects.toMatchObject({ name: "TypeError", message: expect.stringContaining("capnweb-validate:") });
    const selection = await ui.select({ apiId: "validated-api" });
    expect(selection.resourceUrl).toContain("/apis/validated-api/");
    const before = await events(selection.reference.draftId);
    // Reusing a selected UI bypasses its implementation checks; validation must still run.
    await expect(Promise.resolve(ui.select({ selectionDigest: 123 } as unknown as Parameters<SelectionUi["select"]>[0])))
      .rejects.toMatchObject({ name: "TypeError", message: expect.stringContaining("capnweb-validate:") });
    expect(await events(selection.reference.draftId)).toEqual(before);
    expect(await ui.select()).toEqual(selection);
    using connection = await workspace.newGatekeeper(account.id, selection.resourceUrl);
    expect(connection).not.toBeNull();
    using session = await connection!.openSession() as RpcStub<ReadSession & { writeValue(value: number): Promise<number> }>;
    const activeEvents = await events(selection.reference.draftId);
    await expect(Promise.resolve(session.writeValue("unexpected" as unknown as number))).rejects.toMatchObject({ name: "TypeError", message: expect.stringContaining("capnweb-validate:") });
    expect(await events(selection.reference.draftId)).toEqual(activeEvents);
    await expect(session.readValue()).resolves.toBe(1);
  }));

  it("rejects another owner and a wrong intended workspace before the first claim", async () => withSession(async publicApi => {
    const [alice, bob] = nextUsernames("bindingalice", "bindingbob");
    using _signup = await signUp(publicApi, alice);
    using aliceApi = await logIn(publicApi, alice);
    using bobApi = await signUp(publicApi, bob);
    const account = await provision(aliceApi);
    const bobAccount = await provision(bobApi);
    expect(account.id).toBe(0);
    using intended = await aliceApi.newGadget();
    using wrong = await aliceApi.newGadget();
    using bobs = await bobApi.newGadget();
    const { ui, selection } = await select(intended, account);
    using _selectionUi = ui;
    await expect(attemptAdd(bobs, bobAccount.id, selection.resourceUrl)).rejects.toThrow("DRAFT_NOT_FOUND");
    await expect(attemptAdd(wrong, account.id, selection.resourceUrl)).rejects.toThrow("DRAFT_NOT_FOUND");
    await noActivation(selection.reference.draftId);
    expect(await intended.addCollaborator(bob, "build")).not.toBeNull();
    using shared = await bobApi.openGadget((await intended.getMetadata()).id);
    await expect(shared.startBoundResourceConfigurator(bobAccount.id, bobAccount.pattern)).rejects.toThrow("BINDING_OWNER_REQUIRED");
    await expect(attemptAdd(shared, bobAccount.id, selection.resourceUrl)).rejects.toThrow("BINDING_OWNER_REQUIRED");
    using connection = await intended.newGatekeeper(account.id, selection.resourceUrl);
    expect(connection).not.toBeNull();
    expect(await connection!.getId()).toBe(0);
    expect((await events(selection.reference.draftId)).filter(e => e.event === "activated")).toHaveLength(1);
  }));

  it("rejects the same owner's other connected account before claim", async () => withSession(async publicApi => {
    using api = await signUp(publicApi, nextUsernames("bindingaccounts")[0]);
    const account = await provision(api);
    const other = await provision(api, "other");
    expect(other.id).not.toBe(account.id);
    using workspace = await api.newGadget();
    const { ui, selection } = await select(workspace, account);
    using _selectionUi = ui;
    await expect(attemptAdd(workspace, other.id, selection.resourceUrl)).rejects.toThrow("DRAFT_NOT_FOUND");
    await noActivation(selection.reference.draftId);
  }));

  it("rejects an old account's draft after disconnect and a fresh connection", async () => withSession(async publicApi => {
    using api = await signUp(publicApi, nextUsernames("bindingreconnect")[0]);
    const oldAccount = await provision(api);
    using workspace = await api.newGadget();
    const old = await select(workspace, oldAccount);
    using _oldUi = old.ui;
    await api.disconnectAccount(oldAccount.id);
    const account = await provision(api);
    expect(account.id).toBeGreaterThan(oldAccount.id);
    await expect(attemptAdd(workspace, account.id, old.selection.resourceUrl)).rejects.toThrow("DRAFT_NOT_FOUND");
    await noActivation(old.selection.reference.draftId);
    const current = await select(workspace, account);
    using _currentUi = current.ui;
    using connection = await workspace.newGatekeeper(account.id, current.selection.resourceUrl);
    expect(connection).not.toBeNull();
  }));

  it("rejects fabricated and substituted canonical URLs with no activation", async () => withSession(async publicApi => {
    using api = await signUp(publicApi, nextUsernames("bindingurl")[0]);
    const account = await provision(api);
    using workspace = await api.newGadget();
    const { ui, selection } = await select(workspace, account);
    using _selectionUi = ui;
    await expect(attemptAdd(workspace, account.id, selection.resourceUrl.replace(selection.reference.grantId, "fabricated"))).rejects.toThrow("DRAFT_NOT_FOUND");
    for (const url of [selection.resourceUrl.replace("/test-api/", "/other-api/"), selection.resourceUrl.replace("/test-release/", "/other-release/")]) {
      await expect(attemptAdd(workspace, account.id, url)).rejects.toThrow("BINDING_RESOURCE_URL_MISMATCH");
    }
    await noActivation(selection.reference.draftId);
  }));

  it("reuses exactly one facet across concurrent Add and authenticated retry", async () => withSession(async publicApi => {
    const username = nextUsernames("bindingretry")[0];
    using api = await signUp(publicApi, username);
    const account = await provision(api);
    using workspace = await api.newGadget();
    const { ui, selection } = await select(workspace, account);
    using _selectionUi = ui;
    const connections = await Promise.all([workspace.newGatekeeper(account.id, selection.resourceUrl), workspace.newGatekeeper(account.id, selection.resourceUrl)]);
    try {
      expect(connections.every(Boolean)).toBe(true);
      const ids = await Promise.all(connections.map(c => c!.getId()));
      expect(ids).toEqual([0, 0]);
      using retry = await workspace.newGatekeeper(account.id, selection.resourceUrl);
      expect(await retry!.getId()).toBe(ids[0]);
      const recorded = await events(selection.reference.draftId);
      expect(recorded.filter(e => e.event === "activated")).toHaveLength(1);
      for (const event of recorded) expect(Object.keys(event).toSorted()).toEqual(["draftId", "event", "gatekeeperId", "generation", "workspaceId"]);
      const spec = await retry!.getCreationSpec();
      expect(spec).toMatchObject({ resourceUrl: selection.resourceUrl });
      expect(JSON.stringify(spec)).not.toMatch(/authority|finalizer|accountIncarnation|keyEpoch|publicKeyDigest/);
      const response = await control("readFixtureObservations", { label: accountLabel(account) });
      expect(response.status).toBe(200);
      const { calls } = await response.json() as { calls: { method: string; arity: number; propertyNames?: string[] }[] };
      const descriptions = calls.filter(c => c.method === "describe");
      expect(descriptions.length).toBeGreaterThan(0);
      for (const description of descriptions) expect(description.propertyNames).toEqual(["label", "openApiDraftId", "resourceUrl"]);
    } finally { for (const connection of connections) connection?.[Symbol.dispose](); }
  }));

  for (const invalidation of ["cancel", "expire"] as const) {
    it(`rejects a ${invalidation === "cancel" ? "cancelled" : "expired"} draft before activation`, async () => withSession(async publicApi => {
      using api = await signUp(publicApi, nextUsernames(`binding${invalidation}`)[0]);
      const account = await provision(api);
      using workspace = await api.newGadget();
      const { ui, selection } = await select(workspace, account);
      using _selectionUi = ui;
      if (invalidation === "cancel") await ui.cancel();
      else await command("expireDraft", { label: accountLabel(account), draftId: selection.reference.draftId });
      await expect(attemptAdd(workspace, account.id, selection.resourceUrl)).rejects.toThrow(invalidation === "expire" ? "DRAFT_EXPIRED" : /BINDING_REVOKED|DRAFT_CANCELLED/);
      await noActivation(selection.reference.draftId);
    }));
  }

  it("rejects a genuine wrong-facet binding before target activation", async () => withSession(async publicApi => {
    using api = await signUp(publicApi, nextUsernames("bindingcrossover")[0]);
    const account = await provision(api);
    using workspace = await api.newGadget();
    const source = await select(workspace, account);
    const target = await select(workspace, account);
    using _sourceUi = source.ui;
    using _targetUi = target.ui;
    using connection = await workspace.newGatekeeper(account.id, source.selection.resourceUrl);
    const draftId = target.selection.reference.draftId;
    await command("pauseResolution", { draftId });
    const adding = Promise.resolve(workspace.newGatekeeper(account.id, target.selection.resourceUrl));
    try {
      await arrived("resolution", draftId);
      await expect(control("crossoverBinding", { label: accountLabel(account), draftId, otherDraftId: source.selection.reference.draftId })).rejects.toThrow("DRAFT_CONFLICT");
      await noActivation(draftId);
    } finally { await command("releaseResolution", { draftId }); }
    using targetConnection = await adding;
    expect(await targetConnection!.getId()).not.toBe(await connection!.getId());
  }));

  it("fences retained key-use authority after ABA replacement", async () => withSession(async publicApi => {
    using api = await signUp(publicApi, nextUsernames("bindingepoch")[0]);
    const account = await provision(api);
    using workspace = await api.newGadget();
    const { ui, selection } = await select(workspace, account);
    using _selectionUi = ui;
    using _connection = await workspace.newGatekeeper(account.id, selection.resourceUrl);
    const input = { label: accountLabel(account), draftId: selection.reference.draftId };
    await command("rotateDispatchKey", input);
    await expect(control("checkDispatchUse", { ...input, which: "old" })).rejects.toThrow("DISPATCH_KEY_REVOKED");
    const current = await control("checkDispatchUse", { ...input, which: "current" });
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ active: true });
  }));

  for (const failure of ["confirm-selection", "activation", "describe"] as const) {
    it(`does not publish after ${failure} failure`, async () => withSession(async publicApi => {
      using api = await signUp(publicApi, nextUsernames("bindingfailure")[0]);
      const account = await provision(api);
      using workspace = await api.newGadget();
      const { ui, selection } = await select(workspace, account);
      using _selectionUi = ui;
      const input = { label: accountLabel(account), draftId: selection.reference.draftId };
      await command("setDraftFailure", { ...input, failure });
      await expect(attemptAdd(workspace, account.id, selection.resourceUrl)).rejects.toThrow(
        failure === "confirm-selection" ? /SELECTION|IDENTITY_MISMATCH/ : failure === "activation" ? "FIXTURE_ACTIVATION_FAILED" : "FIXTURE_DESCRIPTION_FAILED");
      const recorded = await events(input.draftId);
      expect(recorded.filter(e => e.event === "dispatch-admitted")).toEqual([]);
      if (failure !== "describe") expect(recorded.filter(e => e.event === "activated")).toEqual([]);
      // An activation failure happens before the fixture stores a BoundIdentity, so its
      // identity-shaped event log cannot contain a revocation event for that draft.
      expect(recorded.filter(e => e.event === "revoked")).toHaveLength(failure === "activation" ? 0 : 1);
      await expect(attemptAdd(workspace, account.id, selection.resourceUrl)).rejects.toThrow("BINDING_REVOKED");
      await expect(workspace.getGatekeeperById(0).describe()).rejects.toThrow("No such gatekeeper id: 0");
    }));
  }

  it("removal during paused activation prevents publication", async () => withSession(async publicApi => {
    using api = await signUp(publicApi, nextUsernames("bindingactivate")[0]);
    const account = await provision(api);
    using workspace = await api.newGadget();
    const { ui, selection } = await select(workspace, account);
    using _selectionUi = ui;
    const input = { label: accountLabel(account), draftId: selection.reference.draftId };
    await command("pauseBeforeActivation", input);
    const adding = Promise.resolve(workspace.newGatekeeper(account.id, selection.resourceUrl));
    const addingResult = adding.then(value => ({ value }), error => ({ error: String(error) }));
    await arrived("activation", input.draftId);
    using provisional = await workspace.getGatekeeperById(0);
    try { await provisional.remove(); }
    finally { await command("releaseActivation", input); }
    const result = await addingResult;
    expect(result).toHaveProperty("error");
    if ("error" in result) expect(result.error).toMatch(/BINDING_REVOKED|removed|revoked/i);
    else result.value?.[Symbol.dispose]();
    await noActivation(input.draftId);
  }));

  it("keeps ordinary configurator and connector creation on legacy RPC arity", async () => withSession(async publicApi => {
    using api = await signUp(publicApi, nextUsernames("bindinglegacy")[0]);
    const account = await provision(api, "legacy");
    expect(account.description.hostBindingProtocol).toBeUndefined();
    await expect(api.startResourceConfigurator(account.id, "https://gadgets-test.example/things/*")).rejects.toThrow("no resource configurator");
    using workspace = await api.newGadget();
    using connection = await workspace.newGatekeeper(account.id, "https://gadgets-test.example/things/ordinary");
    expect(connection).not.toBeNull();
    using session = await connection!.openSession() as RpcStub<ReadSession>;
    await expect(session.readValue()).resolves.toBeTypeOf("number");
    const response = await control("readFixtureObservations", { label: accountLabel(account) }, "gatekeeper-test-legacy");
    expect(response.status).toBe(200);
    const { calls } = await response.json() as { calls: { method: string; arity: number }[] };
    expect(calls.filter(c => c.method === "startResourceConfigurator")).toEqual([{ method: "startResourceConfigurator", arity: 1 }]);
    expect(calls.filter(c => c.method === "getGatekeeperClassFor")).toEqual([{ method: "getGatekeeperClassFor", arity: 1 }]);
  }));

  for (const cleanup of ["remove", "disconnect", "delete"] as const) {
    it(`${cleanup} waits for an admitted lease and revocation acknowledgement`, async () => withSession(async publicApi => {
      const username = nextUsernames(`binding${cleanup}`)[0];
      using api = await signUp(publicApi, username);
      const account = await provision(api);
      using workspace = await api.newGadget();
      const { ui, selection } = await select(workspace, account);
      using _selectionUi = ui;
      using connection = await workspace.newGatekeeper(account.id, selection.resourceUrl);
      using session = await connection!.openSession() as RpcStub<ReadSession>;
      const draftId = selection.reference.draftId;
      const input = { label: accountLabel(account), draftId };
      // This separate issuance has no connector draft yet, so only the host can fence its
      // first register call during deletion; the fixture has nothing to cancel itself.
      using unselectedUi = cleanup === "delete"
        ? (await workspace.startBoundResourceConfigurator(account.id, account.pattern)).ui as unknown as RpcStub<SelectionUi>
        : null;
      await command("pauseDispatch", input);
      await command("pauseRevocation", input);
      const read = Promise.resolve(session.readValue());
      // Observe early errors immediately; the value is still asserted after the lease release.
      void read.catch(() => {});
      await arrived("dispatch", draftId);
      let finished = false;
      let closeError: unknown;
      const closing = Promise.resolve(cleanup === "remove" ? connection!.remove() : cleanup === "disconnect" ? api.disconnectAccount(account.id) : workspace.deleteSelf())
        .then(() => { finished = true; }, error => { closeError = error; });
      try {
        await waitFor("revocation fence", async () => {
          if (closeError) throw new Error(`Cleanup failed before its revocation fence: ${String(closeError)}`);
          return (await events(draftId)).some(e => e.event === "revocation-started") ? true : null;
        });
        expect(finished).toBe(false);
        if (unselectedUi) await expect(unselectedUi.select()).rejects.toThrow("BINDING_WORKSPACE_CLOSED");
        await expect(session.readValue()).rejects.toThrow(/BINDING_REVOKED|ACCOUNT_REVOKED|revok|removed|deleted|closed/i);
        expect((await events(draftId)).filter(e => e.event === "dispatch-admitted")).toHaveLength(1);
        await expect(control("checkDispatchUse", { ...input, which: "current" })).rejects.toThrow(/BINDING_REVOKED|BINDING_ACCOUNT_REPLACED|BINDING_WORKSPACE_CLOSED/);
        await command("releaseDispatch", input);
        await expect(read).resolves.toBe(1);
        await arrived("revocation", draftId);
        expect(finished).toBe(false);
        if (cleanup === "disconnect") {
          const response = await control("readFixtureObservations", { label: accountLabel(account) });
          expect(response.status).toBe(200);
          expect((await response.json() as { calls: object[] }).calls).not.toContainEqual({ method: "revoke", arity: 0 });
        }
      } finally {
        await command("releaseDispatch", input);
        await command("releaseRevocation", input);
      }
      await closing;
      if (closeError) throw closeError;
      expect(finished).toBe(true);
      if (cleanup === "disconnect") {
        const response = await control("readFixtureObservations", { label: accountLabel(account) });
        expect(response.status).toBe(200);
        expect((await response.json() as { calls: object[] }).calls).toContainEqual({ method: "revoke", arity: 0 });
      }
      expect((await events(draftId)).filter(e => e.event === "revoked")).toHaveLength(1);
      if (cleanup === "delete") {
        // Deleted workspaces must still acknowledge a later account cleanup fanout.
        await reloadWorkers();
        using freshPublicApi = connect(harness.url);
        using freshApi = await logIn(freshPublicApi, username);
        await freshApi.disconnectAccount(account.id);
        expect((await listConnectedAccounts(freshApi)).some(a => a.id === account.id)).toBe(false);
      }
    }));
  }
  it("recovers an active binding after its draft timestamp expires and Workers reload", async () => {
    const username = nextUsernames("bindingactiveexpiry")[0];
    let accountId: number;
    let workspaceId: string;
    let resourceUrl: string;
    let gatekeeperId: number;
    await withSession(async publicApi => {
      using api = await signUp(publicApi, username);
      const account = await provision(api);
      accountId = account.id;
      using workspace = await api.newGadget();
      workspaceId = (await workspace.getMetadata()).id;
      const { ui, selection } = await select(workspace, account);
      using _selectionUi = ui;
      resourceUrl = selection.resourceUrl;
      using connection = await workspace.newGatekeeper(accountId, resourceUrl);
      gatekeeperId = await connection!.getId();
      // Timestamp-only input mutation: explicit cancellation/revocation remain separate fences.
      // This does not move the host clock or claim to test the host's 15-minute boundary.
      await command("setDraftExpiry", { label: accountLabel(account), draftId: selection.reference.draftId, expiresAt: 0 });
      await reloadWorkers();
    });
    await withSession(async publicApi => {
      using api = await logIn(publicApi, username);
      using workspace = await api.openGadget(workspaceId!);
      await expect(attemptAdd(workspace, accountId!, resourceUrl!)).resolves.toEqual({ gatekeeperId: gatekeeperId! });
      using retry = await workspace.getGatekeeperById(gatekeeperId!);
      using session = await retry!.openSession() as RpcStub<ReadSession>;
      await expect(session.readValue()).resolves.toBe(1);
    });
  });

  it("completes already-revoked account cleanup after real Worker reload and isolates the successor", async () => {
    const username = nextUsernames("bindingrestart")[0];
    let accountId: number;
    let workspaceId: string;
    let draftId: string;
    let resourceUrl: string;
    let label: string;
    await withSession(async publicApi => {
      using api = await signUp(publicApi, username);
      const account = await provision(api);
      accountId = account.id;
      label = accountLabel(account);
      using workspace = await api.newGadget();
      workspaceId = (await workspace.getMetadata()).id;
      const { ui, selection } = await select(workspace, account);
      using _selectionUi = ui;
      draftId = selection.reference.draftId;
      resourceUrl = selection.resourceUrl;
      using _connection = await workspace.newGatekeeper(account.id, resourceUrl);
      // Simulate independent provider revocation using the same durable account state
      // as account.revoke(), before the host begins its recipient-first cleanup.
      await command("revokeAccountExternally", { label });
      await expect(Promise.resolve(workspace.startBoundResourceConfigurator(account.id, account.pattern)).then(() => "configurator-opened")).rejects.toThrow("ACCOUNT_REVOKED");
      await command("pauseRevocation", { draftId });
      // The old transport is expected to close on reload; its rejection is not revocation evidence.
      const interrupted = Promise.resolve(api.disconnectAccount(accountId)).then(() => "completed", () => "transport interrupted");
      await arrived("revocation", draftId);
      expect((await events(draftId)).some(e => e.event === "revoked")).toBe(false);
      const beforeReload = await control("readFixtureObservations", { label });
      expect(beforeReload.status).toBe(200);
      const beforeCalls = (await beforeReload.json() as { calls: object[] }).calls;
      expect(beforeCalls).toContainEqual({ method: "external-revoke", arity: 0 });
      expect(beforeCalls).not.toContainEqual({ method: "revoke", arity: 0 });
      await reloadWorkers();
      await interrupted;
    });
    await withSession(async publicApi => {
      using api = await logIn(publicApi, username);
      using workspace = await api.openGadget(workspaceId!);
      const afterReload = await control("readFixtureObservations", { label: label! });
      expect(afterReload.status).toBe(200);
      expect((await afterReload.json() as { calls: object[] }).calls).toContainEqual({ method: "external-revoke", arity: 0 });
      await api.disconnectAccount(accountId!);
      await api.disconnectAccount(accountId!);
      expect((await events(draftId!)).filter(e => e.event === "revoked")).toHaveLength(1);
      const successor = await provision(api);
      expect(successor.id).toBeGreaterThan(accountId!);
      await expect(attemptAdd(workspace, successor.id, resourceUrl!)).rejects.toThrow("DRAFT_NOT_FOUND");
      const fresh = await select(workspace, successor);
      using _freshUi = fresh.ui;
      using connection = await workspace.newGatekeeper(successor.id, fresh.selection.resourceUrl);
      using session = await connection!.openSession() as RpcStub<ReadSession>;
      await expect(session.readValue()).resolves.toBe(1);
      await api.disconnectAccount(accountId!);
      await expect(session.readValue()).resolves.toBe(1);
    });
  });

});
