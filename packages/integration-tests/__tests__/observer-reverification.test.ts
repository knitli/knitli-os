// Regression tests for observer re-verification on re-open.
//
// A collaborator's observer account choice is persisted after their first successful open, so on every
// later open ensureObserver() re-verifies without prompting. When that verification fails -- routinely,
// because credentials lapse -- the open used to dead-end with "You are not permitted to observe all of
// the data this Gadget has accessed" and no way forward. It should instead re-prompt through
// ObserverConfigCallback with the failure attached, and if the re-prompt doesn't fix it, say which
// connection and which account failed.
//
// Nothing is stubbed but the network. The real workshop-backend runs under wrangler, tests speak Cap'n
// Web over a WebSocket to /api exactly as the browser does, and the gatekeeper is a real Worker
// speaking the real protocol -- one whose verification outcome the tests set, which is the whole reason
// the fixture exists (see fixtures/gatekeeper-test/src/test-gatekeeper.ts).

import type { AuthenticatedApi, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import type { RpcStub, RpcTarget } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Harness,
  startHarness,
  TEST_GATEKEEPER_BINDING,
  TEST_GATEKEEPER_DIR,
  TEST_GATEKEEPER_WORKER,
  TEST_VENDOR_ID,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel,
  type ConnectedAccount,
  connect,
  listConnectedAccounts,
  logIn,
  MAX_OBSERVER_PROMPTS,
  nextUsernames,
  ObserverConfigRecorder,
  signUp,
  stubFor,
  waitFor,
} from "../src/rpc-client.js";

// Reason text shaped like the two failures a gatekeeper actually reports. The overseer cannot tell
// them apart -- both arrive as a thrown error -- so what the user reads is the reason itself.
const EXPIRED_REASON = "credentials expired — please reconnect";
const DENIED_REASON = "You do not have access to this thing.";

let harness: Harness;
let interceptor: NetworkInterceptor;

interface TestSessionApi extends RpcTarget {
  observe(): Promise<void>;
  act(): Promise<void>;
  bindHook(): Promise<void>;
}

beforeAll(async () => {
  // No handlers: nothing here should make an outbound request at all, so every one is a failure.
  // The fetch-probe case below is what proves this is actually wired up.
  interceptor = new NetworkInterceptor();
  interceptor.install();
  harness = await startHarness({
    gatekeepers: [
      {
        binding: TEST_GATEKEEPER_BINDING,
        dir: TEST_GATEKEEPER_DIR,
        patch(config) {
          config.services = [
            ...(config.services ?? []),
            {
              binding: "EXTERNAL_MESSAGE_GATEWAY",
              service: "workshop-backend",
              entrypoint: "ExternalMessageGateway",
              props: { source: "observer-readiness" },
            },
          ];
        },
      },
    ],
  });
});

afterAll(async () => {
  // Any outbound request means a test reached for the real internet. Asserted once for the whole file
  // rather than per test: the tests run concurrently, so an afterEach would be inspecting and clearing
  // state that sibling tests are still using.
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close();
  interceptor.uninstall();
  interceptor.reset();
  expect(unmocked).toEqual([]);
});

// Each test gets its own RPC session, so a disposal in one can't disturb another running alongside.
async function withSession<T>(body: (api: RpcStub<PublicApi>) => Promise<T>): Promise<T> {
  const publicApi = connect(harness.url);
  try {
    return await body(publicApi);
  } finally {
    publicApi[Symbol.dispose]();
  }
}

function thingUrl(name: string): string {
  return `https://gadgets-test.example/things/${name}`;
}

/** Mint this user's test-gatekeeper account -- no auth flow -- and read it back. */
async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find((a) => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

/** Tell the gatekeeper what to do the next time it's asked to admit `label` as an observer. */
async function setVerifyOutcome(
  label: string,
  outcome: { allow: true } | { allow: false; reason: string },
): Promise<void> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/verify-outcome",
    { method: "POST", body: JSON.stringify({ label, ...outcome }) },
  );
  if (res.status !== 204) {
    // The control route answers a rejected body with 400 and a reason, so surface it here rather
    // than leaving a bare status to be puzzled over.
    throw new Error(`Setting the verify outcome failed with ${res.status}: ${await res.text()}`);
  }
}

async function ambientVerificationCount(label: string): Promise<number> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/ambient-verification-count",
    { method: "POST", body: JSON.stringify({ label }) },
  );
  if (res.status !== 200) {
    throw new Error(
      `Reading the ambient verification count failed with ${res.status}: ${await res.text()}`,
    );
  }
  return ((await res.json()) as { count: number }).count;
}

async function observerIds(label: string): Promise<string[]> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/observer-ids",
    { method: "POST", body: JSON.stringify({ label }) },
  );
  if (res.status !== 200) {
    throw new Error(`Reading observer IDs failed with ${res.status}: ${await res.text()}`);
  }
  return ((await res.json()) as { ids: string[] }).ids;
}

async function sessionCounts(resourceUrl: string): Promise<{ started: number; disposed: number }> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/session-counts",
    { method: "POST", body: JSON.stringify({ resourceUrl }) },
  );
  if (res.status !== 200) {
    throw new Error(`Reading session counts failed with ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { started: number; disposed: number };
}

function barrierKey(kind: string, resourceUrl: string): string {
  return `${kind}:${resourceUrl}`;
}

async function controlBarrier(path: "arm-barrier" | "release-barrier", key: string): Promise<void> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    `http://gatekeeper-test.test/control/${path}`,
    { method: "POST", body: JSON.stringify({ key }) },
  );
  if (res.status !== 204) {
    throw new Error(`${path} failed with ${res.status}: ${await res.text()}`);
  }
}

async function barrierArrivals(key: string): Promise<number> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/barrier-arrivals",
    { method: "POST", body: JSON.stringify({ key }) },
  );
  if (res.status !== 200) {
    throw new Error(`Reading barrier arrivals failed with ${res.status}: ${await res.text()}`);
  }
  return ((await res.json()) as { arrivals: number }).arrivals;
}

async function waitForBarrier(key: string, minimum = 1): Promise<void> {
  await waitFor(`barrier ${key} to receive ${minimum} arrival(s)`, async () => {
    const arrivals = await barrierArrivals(key);
    return arrivals >= minimum ? true : null;
  });
}

async function settleWithin<T>(
  what: string,
  promise: Promise<T>,
  timeoutMs = 5_000,
): Promise<PromiseSettledResult<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: "fulfilled", value }) as const,
        (reason) => ({ status: "rejected", reason }) as const,
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${what} to settle`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function startFixtureHook(key: string): Promise<{ status: number; error?: string }> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/start-hook",
    { method: "POST", body: JSON.stringify({ key }) },
  );
  const body = res.status === 204 ? {} : ((await res.json()) as { error?: string });
  return { status: res.status, ...body };
}

async function submitExternalMessage(
  callerEmail: string,
  gadgetKey: string,
  gadgetTitle: string,
): Promise<{ accepted: boolean; message?: string }> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER,
    "http://gatekeeper-test.test/control/submit-external-message",
    {
      method: "POST",
      body: JSON.stringify({ callerEmail, gadgetKey, gadgetTitle }),
    },
  );
  if (res.status !== 200) {
    throw new Error(`External message control failed with ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { accepted: boolean; message?: string };
}

type SharedGadget = {
  gadgetId: string;
  bobApi: RpcStub<AuthenticatedApi>;
  bobAccount: ConnectedAccount;
  /** Bob's account label: what the gatekeeper keys outcomes on and the Workshop names in a message. */
  bobLabel: string;
  /** Make the gatekeeper refuse Bob from now on, as if his credential lapsed between opens. */
  failBob(reason: string): Promise<void>;
};

// Alice creates a gadget bound to each thing, shares it with Bob as "build", and Bob gets his own
// account. Call failBob() to put the gadget into the state the bug lives in.
//
// `thingNames` names the fixture gatekeeper's "Test Thing" resources to bind, one gatekeeper each --
// thingUrl() turns each name into a resource URL. They also end up in the failure message the last
// two cases assert on ("Test Thing multi-a"), so pass something recognisable per test.
async function shareGadgetWithBob(
  publicApi: RpcStub<PublicApi>,
  thingNames: string[],
): Promise<SharedGadget> {
  const [alice, bob] = nextUsernames("alice", "bob");

  const aliceApi = await signUp(publicApi, alice);
  // Bob must exist before he can be added as a collaborator.
  const bobApi = await signUp(publicApi, bob);

  const aliceAccount = await provisionAccount(aliceApi);

  const overseer = await aliceApi.newGadget();
  for (const thingName of thingNames) {
    await overseer.newGatekeeper(aliceAccount.id, thingUrl(thingName));
  }
  const { id: gadgetId } = await overseer.getMetadata();
  const collaborator = await overseer.addCollaborator(bob, "build");
  if (!collaborator) throw new Error(`Failed to share the gadget with ${bob}`);
  overseer[Symbol.dispose]();

  const bobAccount = await provisionAccount(bobApi);
  const bobLabel = accountLabel(bobAccount);

  return {
    gadgetId,
    bobApi,
    bobAccount,
    bobLabel,
    failBob: (reason) => setVerifyOutcome(bobLabel, { allow: false, reason }),
  };
}

// Bob opens the gadget, answering any observer prompt from `recorder`.
async function bobOpens(
  shared: SharedGadget,
  recorder: ObserverConfigRecorder,
): Promise<RpcStub<Overseer>> {
  const callback = stubFor(recorder);
  try {
    return await shared.bobApi.openGadget(shared.gadgetId, undefined, callback);
  } finally {
    callback[Symbol.dispose]();
  }
}

/** Open once and answer the prompt, which is what persists Bob's account choice. */
async function bobOpensAndCloses(shared: SharedGadget): Promise<ObserverConfigRecorder> {
  const recorder = new ObserverConfigRecorder().alwaysChoose(
    shared.bobAccount.id,
    MAX_OBSERVER_PROMPTS,
  );
  (await bobOpens(shared, recorder))[Symbol.dispose]();
  return recorder;
}

describe("observer re-verification", () => {
  it.concurrent("rejects owner-only connection publication while a collaborator is active", async () => {
    await withSession(async (publicApi) => {
      const [alice, bob] = nextUsernames("policyalice", "policybob");
      using aliceApi = await signUp(publicApi, alice);
      using _bobApi = await signUp(publicApi, bob);
      const aliceAccount = await provisionAccount(aliceApi);
      using ownerWorkspace = await aliceApi.newGadget();
      if (!(await ownerWorkspace.addCollaborator(bob, "build"))) {
        throw new Error(`Failed to share the gadget with ${bob}`);
      }

      await expect(
        ownerWorkspace.newGatekeeper(aliceAccount.id, thingUrl("owner-only-shared")),
      ).rejects.toThrow(/owner-only.*shared/i);
    });
  });

  it.concurrent("makes the first owner-only observation sticky without blocking owner actions", async () => {
    await withSession(async (publicApi) => {
      const [alice, bob] = nextUsernames("stickyalice", "stickybob");
      using aliceApi = await signUp(publicApi, alice);
      using _bobApi = await signUp(publicApi, bob);
      const aliceAccount = await provisionAccount(aliceApi);
      using ownerWorkspace = await aliceApi.newGadget();
      using ownerOnly = await ownerWorkspace.newGatekeeper(
        aliceAccount.id,
        thingUrl("owner-only-sticky"),
      );
      if (!ownerOnly) throw new Error("Failed to create the owner-only test connection");
      using session = (await ownerOnly.openSession()) as RpcStub<TestSessionApi>;

      await expect(session.observe()).resolves.toBeUndefined();
      await expect(session.act()).resolves.toBeUndefined();
      await expect(ownerWorkspace.getMetadata()).resolves.toMatchObject({
        sharingProhibited: true,
      });

      // Removing the policy-bearing connection must not erase confidentiality established by a
      // completed observation.
      await ownerOnly.remove();
      await expect(ownerWorkspace.addCollaborator(bob, "build")).rejects.toThrow(
        /cannot be shared|prevent leaks/i,
      );
      await expect(ownerWorkspace.createShareLink("use")).rejects.toThrow(
        /cannot be shared|prevent leaks/i,
      );
      await expect(ownerWorkspace.getMetadata()).resolves.toMatchObject({
        sharingProhibited: true,
      });
    });
  });

  it.concurrent("blocks a late connection until a previously admitted build collaborator reopens", async () => {
    await withSession(async (publicApi) => {
      const [alice, bob] = nextUsernames("latealice", "latebob");
      using aliceApi = await signUp(publicApi, alice);
      using bobApi = await signUp(publicApi, bob);
      const bobAccount = await provisionAccount(bobApi);

      using ownerWorkspace = await aliceApi.newGadget();
      const { id: gadgetId } = await ownerWorkspace.getMetadata();
      if (!(await ownerWorkspace.addCollaborator(bob, "build"))) {
        throw new Error(`Failed to share the gadget with ${bob}`);
      }

      // Bob is admitted while the workspace has no account-requiring connections. This must still
      // persist his observer identity, otherwise a connection added later cannot see that a current
      // collaborator has not verified it.
      (await bobApi.openGadget(gadgetId))[Symbol.dispose]();

      const aliceAccount = await provisionAccount(aliceApi);
      using late = await ownerWorkspace.newGatekeeper(aliceAccount.id, thingUrl("late-build"));
      if (!late) throw new Error("Failed to create the late test connection");

      await expect(late.openSession()).rejects.toThrow(/collaborators.*re-opened/i);

      const recorder = new ObserverConfigRecorder().alwaysChoose(
        bobAccount.id,
        MAX_OBSERVER_PROMPTS,
      );
      const callback = stubFor(recorder);
      try {
        (await bobApi.openGadget(gadgetId, undefined, callback))[Symbol.dispose]();
      } finally {
        callback[Symbol.dispose]();
      }

      using _session = await late.openSession();
      expect(recorder.callCount).toBe(1);
    });
  });

  it.concurrent("records zero-scope opens so a later connection requires reconfiguration", async () => {
    await withSession(async (publicApi) => {
      const [alice, bob] = nextUsernames("concurrentalice", "concurrentbob");
      using aliceApi = await signUp(publicApi, alice);
      using bobApi = await signUp(publicApi, bob);
      const bobAccount = await provisionAccount(bobApi);

      using ownerWorkspace = await aliceApi.newGadget();
      const { id: gadgetId } = await ownerWorkspace.getMetadata();
      if (!(await ownerWorkspace.addCollaborator(bob, "build"))) {
        throw new Error(`Failed to share the gadget with ${bob}`);
      }

      // These requests have no in-scope connection to configure. Their purpose is not an observer
      // identity race (the controlled in-scope test below owns that assertion), but to prove the
      // zero-scope admission record survives repeated opens and is consulted when scope expands.
      const opened = await Promise.all([bobApi.openGadget(gadgetId), bobApi.openGadget(gadgetId)]);
      for (const workspace of opened) workspace[Symbol.dispose]();

      const aliceAccount = await provisionAccount(aliceApi);
      using late = await ownerWorkspace.newGatekeeper(aliceAccount.id, thingUrl("stable-id"));
      if (!late) throw new Error("Failed to create the late test connection");
      await expect(late.openSession()).rejects.toThrow(/collaborators.*re-opened/i);

      const recorder = new ObserverConfigRecorder().alwaysChoose(
        bobAccount.id,
        MAX_OBSERVER_PROMPTS,
      );
      const callback = stubFor(recorder);
      let bobWorkspace!: RpcStub<Overseer>;
      try {
        bobWorkspace = await bobApi.openGadget(gadgetId, undefined, callback);
      } finally {
        callback[Symbol.dispose]();
      }
      bobWorkspace[Symbol.dispose]();
    });
  });

  it.concurrent("serializes concurrent in-scope observer admission", async () => {
    await withSession(async (publicApi) => {
      const [alice, bob] = nextUsernames("admissionalice", "admissionbob");
      using aliceApi = await signUp(publicApi, alice);
      using bobApi = await signUp(publicApi, bob);
      const aliceAccount = await provisionAccount(aliceApi);
      const bobAccount = await provisionAccount(bobApi);
      const resourceUrl = thingUrl("add-observer-barrier");
      const key = barrierKey("add-observer", resourceUrl);

      using ownerWorkspace = await aliceApi.newGadget();
      using connection = await ownerWorkspace.newGatekeeper(aliceAccount.id, resourceUrl);
      if (!connection) throw new Error("Failed to create the admission-race connection");
      const { id: gadgetId } = await ownerWorkspace.getMetadata();
      if (!(await ownerWorkspace.addCollaborator(bob, "build"))) {
        throw new Error(`Failed to share the gadget with ${bob}`);
      }

      await controlBarrier("arm-barrier", key);
      const recorder = new ObserverConfigRecorder().alwaysChoose(
        bobAccount.id,
        MAX_OBSERVER_PROMPTS,
      );
      const firstCallback = stubFor(recorder);
      const secondCallback = stubFor(recorder);
      const openPromises = [
        bobApi.openGadget(gadgetId, undefined, firstCallback),
        bobApi.openGadget(gadgetId, undefined, secondCallback),
      ];
      let barrierReleased = false;
      try {
        await waitForBarrier(key);
        // The deterministic unit tests for KeyedAsyncSequencer own the ordering proof. This real
        // open path verifies the sequencer is wired into collaborator admission and converges on a
        // single observer identity after both opens complete.
        await controlBarrier("release-barrier", key);
        barrierReleased = true;
        await Promise.all(openPromises);
        expect(await observerIds(accountLabel(bobAccount))).toHaveLength(1);
      } finally {
        if (!barrierReleased) {
          await controlBarrier("release-barrier", key).catch(() => undefined);
        }
        const opened = await Promise.allSettled(openPromises);
        for (const result of opened) {
          if (result.status === "fulfilled") result.value[Symbol.dispose]();
        }
        firstCallback[Symbol.dispose]();
        secondCallback[Symbol.dispose]();
      }
    });
  });

  it.concurrent("does not publish collaborator bookkeeping when revocation wins a paused open", async () => {
    await withSession(async (publicApi) => {
      const [alice, bob] = nextUsernames("openracealice", "openracebob");
      using aliceApi = await signUp(publicApi, alice);
      using bobApi = await signUp(publicApi, bob);
      const aliceAccount = await provisionAccount(aliceApi);
      const bobAccount = await provisionAccount(bobApi);
      const bobProfile = await bobApi.whoami();
      const resourceUrl = thingUrl("add-observer-barrier-open-race");
      const key = barrierKey("add-observer", resourceUrl);

      using ownerWorkspace = await aliceApi.newGadget();
      using connection = await ownerWorkspace.newGatekeeper(aliceAccount.id, resourceUrl);
      if (!connection) throw new Error("Failed to create open-race connection");
      using _gadget = await ownerWorkspace.createGadget(
        "Revoked open output",
        undefined,
        "TEST_GADGET",
      );
      const { id: gadgetId } = await ownerWorkspace.getMetadata();
      if (!(await ownerWorkspace.addCollaborator(bob, "build"))) {
        throw new Error(`Failed to share the gadget with ${bob}`);
      }

      const recorder = new ObserverConfigRecorder().alwaysChoose(
        bobAccount.id,
        MAX_OBSERVER_PROMPTS,
      );
      const callback = stubFor(recorder);
      await controlBarrier("arm-barrier", key);
      const opening = bobApi.openGadget(gadgetId, undefined, callback);
      const openingSettlement = settleWithin("the paused collaborator open", opening);
      try {
        await waitForBarrier(key);
        await settleWithin(
          "the paused-open collaborator removal",
          ownerWorkspace.removeCollaborator(bobProfile.id, []),
        );
      } finally {
        await controlBarrier("release-barrier", key).catch(() => undefined);
        callback[Symbol.dispose]();
      }

      const openingResult = await openingSettlement;
      expect(openingResult.status).toBe("rejected");
      if (openingResult.status === "rejected") {
        expect(String(openingResult.reason)).toMatch(/access|closed|disconnect|restart|revok/i);
      }

      const freshPublicApi = connect(harness.url);
      try {
        const freshBobApi = await logIn(freshPublicApi, bob);
        try {
          expect((await freshBobApi.listGadgets()).some(({ id }) => id === gadgetId)).toBe(false);
          expect(
            (await freshBobApi.listOutputs()).outputs.some(
              ({ workspaceId }) => workspaceId === gadgetId,
            ),
          ).toBe(false);
        } finally {
          freshBobApi[Symbol.dispose]();
        }
      } finally {
        freshPublicApi[Symbol.dispose]();
      }
    });
  });

  it.concurrent("rejects a startSession that becomes unreadied and disposes its returned session", async () => {
    await withSession(async (publicApi) => {
      const [alice, bob] = nextUsernames("startalice", "startbob");
      using aliceApi = await signUp(publicApi, alice);
      using bobApi = await signUp(publicApi, bob);
      const aliceAccount = await provisionAccount(aliceApi);
      const bobAccount = await provisionAccount(bobApi);
      const resourceUrl = thingUrl("start-session-barrier");
      const key = barrierKey("start-session", resourceUrl);

      using ownerWorkspace = await aliceApi.newGadget();
      using connection = await ownerWorkspace.newGatekeeper(aliceAccount.id, resourceUrl);
      if (!connection) throw new Error("Failed to create the start-session race connection");
      using gadget = await ownerWorkspace.createGadget("Start race", undefined, "TEST_GADGET");
      const { id: gadgetId } = await ownerWorkspace.getMetadata();
      if (!(await ownerWorkspace.addCollaborator(bob, "use"))) {
        throw new Error(`Failed to share the gadget with ${bob}`);
      }

      // This unbound connection is outside Bob's initial use scope, so his open stores an empty
      // observer choice. Binding it while startSession is paused makes the post-await readiness
      // check mandatory rather than merely a duplicate of the initial check.
      const recorder = new ObserverConfigRecorder().alwaysChoose(
        bobAccount.id,
        MAX_OBSERVER_PROMPTS,
      );
      const callback = stubFor(recorder);
      try {
        (await bobApi.openGadget(gadgetId, undefined, callback))[Symbol.dispose]();
      } finally {
        callback[Symbol.dispose]();
      }
      await controlBarrier("arm-barrier", key);
      const opening = connection.openSession();
      try {
        await waitForBarrier(key);
        await gadget.bind("TEST_THING", await connection.getId());
      } finally {
        await controlBarrier("release-barrier", key);
      }
      await expect(opening).rejects.toThrow(/collaborators.*re-opened/i);
      await waitFor("the post-readiness rejected session to be disposed", async () => {
        const counts = await sessionCounts(resourceUrl);
        return counts.started === 1 && counts.disposed === 1 ? true : null;
      });

      // Bob now configures the newly in-scope connection; only then may the owner obtain a session.
      const reconfigureRecorder = new ObserverConfigRecorder().alwaysChoose(
        bobAccount.id,
        MAX_OBSERVER_PROMPTS,
      );
      const reconfigureCallback = stubFor(reconfigureRecorder);
      try {
        (await bobApi.openGadget(gadgetId, undefined, reconfigureCallback))[Symbol.dispose]();
      } finally {
        reconfigureCallback[Symbol.dispose]();
      }
      using session = await connection.openSession();
      expect(reconfigureRecorder.callCount).toBe(1);
      session[Symbol.dispose]();
    });
  });

  it.concurrent("rejects owner-only publication when sharing starts during describe", async () => {
    await withSession(async (publicApi) => {
      const [alice, bob] = nextUsernames("describealice", "describebob");
      using aliceApi = await signUp(publicApi, alice);
      using _bobApi = await signUp(publicApi, bob);
      const aliceAccount = await provisionAccount(aliceApi);
      const resourceUrl = thingUrl("owner-only-describe-barrier");
      const key = barrierKey("describe", resourceUrl);
      using ownerWorkspace = await aliceApi.newGadget();
      using existing = await ownerWorkspace.newGatekeeper(
        aliceAccount.id,
        thingUrl("describe-existing"),
      );
      if (!existing) throw new Error("Failed to create the pre-existing connection");

      await controlBarrier("arm-barrier", key);
      const publishing = ownerWorkspace.newGatekeeper(aliceAccount.id, resourceUrl);
      try {
        await waitForBarrier(key);
        // The incomplete record is fail-closed when addressed directly, but it must not make an
        // unrelated established capability unusable while its describe RPC remains pending.
        using existingSession = await existing.openSession();
        existingSession[Symbol.dispose]();
        await expect(ownerWorkspace.listObserverRequirements("build")).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ resourceUrl: thingUrl("describe-existing") }),
          ]),
        );
        if (!(await ownerWorkspace.addCollaborator(bob, "build"))) {
          throw new Error(`Failed to share the gadget with ${bob}`);
        }
      } finally {
        await controlBarrier("release-barrier", key);
      }
      await expect(publishing).rejects.toThrow(/owner-only.*shared/i);
      await expect(ownerWorkspace.listObserverRequirements("build")).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ resourceUrl })]),
      );
    });
  });

  it("severs retained collaborator writes and preserves owner state across revocation restart", async () => {
    await withSession(async (publicApi) => {
      const [alice, bob] = nextUsernames("revokealice", "revokebob");
      using aliceApi = await signUp(publicApi, alice);
      using bobApi = await signUp(publicApi, bob);
      const aliceAccount = await provisionAccount(aliceApi);
      const bobAccount = await provisionAccount(bobApi);
      const resourceUrl = thingUrl("revocation-restart");

      using ownerWorkspace = await aliceApi.newGadget();
      using connection = await ownerWorkspace.newGatekeeper(aliceAccount.id, resourceUrl);
      if (!connection) throw new Error("Failed to create the revocation-race connection");
      const { id: gadgetId, title: originalTitle } = await ownerWorkspace.getMetadata();
      const bobProfile = await bobApi.whoami();
      if (!(await ownerWorkspace.addCollaborator(bob, "build"))) {
        throw new Error(`Failed to share the gadget with ${bob}`);
      }
      const recorder = new ObserverConfigRecorder().alwaysChoose(
        bobAccount.id,
        MAX_OBSERVER_PROMPTS,
      );
      const callback = stubFor(recorder);
      let bobWorkspace!: RpcStub<Overseer>;
      try {
        bobWorkspace = await bobApi.openGadget(gadgetId, undefined, callback);
      } finally {
        callback[Symbol.dispose]();
      }

      // The sharing mutation is submitted first on the same Cap'n Web session. Production removes
      // the graph edge, starts best-effort observer/listing cleanup, then immediately closes the DO
      // input gate and restarts it. A retained broad workspace capability must therefore never get
      // a write through the contraction window, even if remote cleanup does not complete.
      const removing = ownerWorkspace.removeCollaborator(bobProfile.id, []);
      const revokedWrite = bobWorkspace.setTitle("revoked write");
      const [, writeResult] = await Promise.all([
        settleWithin("collaborator removal", removing),
        settleWithin("retained collaborator write", revokedWrite),
      ]);
      expect(writeResult.status).toBe("rejected");
      if (writeResult.status === "rejected") {
        expect(String(writeResult.reason)).toMatch(
          /access|closed|disconnect|disposed|restart|revok/i,
        );
      }
      bobWorkspace[Symbol.dispose]();

      const reopened = await waitFor(
        "the owner to reconnect to the restarted workspace",
        async () => {
          const freshPublicApi = connect(harness.url);
          try {
            const freshAliceApi = await logIn(freshPublicApi, alice);
            const freshOwner = await freshAliceApi.openGadget(gadgetId);
            return { freshAliceApi, freshOwner, freshPublicApi };
          } catch {
            freshPublicApi[Symbol.dispose]();
            return null;
          }
        },
      );
      try {
        await expect(reopened.freshOwner.getMetadata()).resolves.toMatchObject({
          id: gadgetId,
          title: originalTitle,
        });
        await expect(reopened.freshOwner.listCollaborators()).resolves.not.toEqual(
          expect.arrayContaining([expect.objectContaining({ profile: { id: bobProfile.id } })]),
        );

        const freshBobApi = await logIn(reopened.freshPublicApi, bob);
        try {
          await expect(freshBobApi.openGadget(gadgetId)).rejects.toThrow(
            /access|not found|permission/i,
          );
        } finally {
          freshBobApi[Symbol.dispose]();
        }
      } finally {
        reopened.freshOwner[Symbol.dispose]();
        reopened.freshAliceApi[Symbol.dispose]();
        reopened.freshPublicApi[Symbol.dispose]();
      }
    });
  });

  it.concurrent("blocks a retained use-scoped session after its connection becomes bound", async () => {
    await withSession(async (publicApi) => {
      const [alice, bob] = nextUsernames("usealice", "usebob");
      using aliceApi = await signUp(publicApi, alice);
      using bobApi = await signUp(publicApi, bob);
      const aliceAccount = await provisionAccount(aliceApi);
      const bobAccount = await provisionAccount(bobApi);

      using ownerWorkspace = await aliceApi.newGadget();
      using connection = await ownerWorkspace.newGatekeeper(aliceAccount.id, thingUrl("use-bound"));
      if (!connection) throw new Error("Failed to create the test connection");
      using retainedSession = (await connection.openSession()) as RpcStub<TestSessionApi>;
      using gadget = await ownerWorkspace.createGadget("Test Gadget", undefined, "TEST_GADGET");
      const { id: gadgetId } = await ownerWorkspace.getMetadata();
      if (!(await ownerWorkspace.addCollaborator(bob, "use"))) {
        throw new Error(`Failed to share the gadget with ${bob}`);
      }

      // An unbound connection is outside a use collaborator's scope, so Bob is admitted with an
      // empty choice set while the owner already holds a session to that connection.
      (await bobApi.openGadget(gadgetId))[Symbol.dispose]();

      // Queue one action and enable one hook while the connection is still outside Bob's scope.
      // Their later egress paths must re-check readiness rather than trusting submit/bind time.
      await retainedSession.act();
      const pendingAction = (await ownerWorkspace.listActions()).find(
        (action) => action.description.title === "Test action",
      );
      if (!pendingAction) throw new Error("Fixture action was not recorded");
      await retainedSession.bindHook();
      const hook = (await ownerWorkspace.listHooks()).find(
        (entry) => entry.description.title === "Test hook",
      );
      if (!hook) throw new Error("Fixture hook was not recorded");
      await ownerWorkspace.enableHook(hook.id);

      await gadget.bind("TEST_THING", await connection.getId());

      await expect(retainedSession.observe()).rejects.toThrow(/collaborators.*re-opened/i);
      await expect(retainedSession.act()).rejects.toThrow(/collaborators.*re-opened/i);
      await expect(retainedSession.bindHook()).rejects.toThrow(/collaborators.*re-opened/i);
      await expect(ownerWorkspace.approveAction(pendingAction.id)).rejects.toThrow(
        /collaborators.*re-opened/i,
      );
      await expect(startFixtureHook(thingUrl("use-bound"))).resolves.toMatchObject({
        status: 409,
        error: expect.stringMatching(/collaborators.*re-opened/i),
      });

      const recorder = new ObserverConfigRecorder().alwaysChoose(
        bobAccount.id,
        MAX_OBSERVER_PROMPTS,
      );
      const configure = stubFor(recorder);
      try {
        (await bobApi.openGadget(gadgetId, undefined, configure))[Symbol.dispose]();
      } finally {
        configure[Symbol.dispose]();
      }

      await expect(retainedSession.observe()).resolves.toBeUndefined();
      await expect(retainedSession.act()).resolves.toBeUndefined();
      await expect(ownerWorkspace.approveAction(pendingAction.id)).resolves.toBeUndefined();
      await expect(startFixtureHook(thingUrl("use-bound"))).resolves.toEqual({
        status: 204,
      });
      expect(recorder.callCount).toBe(1);
    });
  });

  it("denies an external build collaborator until observer setup is complete", async () => {
    await withSession(async (publicApi) => {
      const [alice, bob] = nextUsernames("externalalice", "externalbob");
      using aliceApi = await signUp(publicApi, alice);
      using bobApi = await signUp(publicApi, bob);
      const gadgetKey = crypto.randomUUID();
      const title = `External observer ${gadgetKey}`;
      const backend = harness.server.getWorker("workshop-backend");
      const beforeIds = new Set(await backend.listDurableObjectIds("OverseerDurableObject"));

      // The first external submission creates Alice's deterministic workspace. It stops at model
      // resolution because these test accounts intentionally have no model configured.
      await expect(submitExternalMessage(alice, gadgetKey, title)).resolves.toMatchObject({
        accepted: false,
        message: expect.stringMatching(/AI model configured/i),
      });
      const createdIds = (await backend.listDurableObjectIds("OverseerDurableObject")).filter(
        (id) => !beforeIds.has(id),
      );
      expect(createdIds).toHaveLength(1);
      const [workspaceId] = createdIds;

      using ownerWorkspace = await aliceApi.openGadget(workspaceId);
      if (!(await ownerWorkspace.addCollaborator(bob, "build"))) {
        throw new Error(`Failed to share the gadget with ${bob}`);
      }
      // Admit Bob while scope is empty, then add a connection he has not configured.
      (await bobApi.openGadget(workspaceId))[Symbol.dispose]();
      const aliceAccount = await provisionAccount(aliceApi);
      using _late = await ownerWorkspace.newGatekeeper(aliceAccount.id, thingUrl("external-late"));

      const denied = await submitExternalMessage(bob, gadgetKey, title);
      expect(denied.accepted).toBe(false);
      expect(denied.message).toMatch(/open.*workspace.*configure/i);
      expect(denied.message).not.toMatch(/AI model/i);
    });
  });

  it.concurrent("lists the connections each sharing role must verify", async () => {
    await withSession(async (publicApi) => {
      const [alice] = nextUsernames("alice");
      using aliceApi = await signUp(publicApi, alice);
      const account = await provisionAccount(aliceApi);
      using overseer = await aliceApi.newGadget();

      using bound = await overseer.newGatekeeper(account.id, thingUrl("bound"));
      using unbound = await overseer.newGatekeeper(account.id, thingUrl("unbound"));
      if (!bound || !unbound) throw new Error("Failed to create test connections");

      using gadget = await overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
      await gadget.bind("TEST_THING", await bound.getId());

      await expect(overseer.listObserverRequirements("use")).resolves.toEqual([
        expect.objectContaining({
          gatekeeperId: await bound.getId(),
          vendorId: TEST_VENDOR_ID,
          resourceTitle: "Test Thing bound",
          resourceUrl: thingUrl("bound"),
        }),
      ]);
      await expect(overseer.listObserverRequirements("build")).resolves.toEqual([
        expect.objectContaining({ resourceTitle: "Test Ambient" }),
        expect.objectContaining({ resourceTitle: "Test Thing bound" }),
        expect.objectContaining({ resourceTitle: "Test Thing unbound" }),
      ]);
    });
  });

  it.concurrent("automatically uses the collaborator's ambient account without prompting", async () => {
    await withSession(async (publicApi) => {
      const [alice, bob] = nextUsernames("ambientalice", "ambientbob");
      const aliceApi = await signUp(publicApi, alice);
      const bobApi = await signUp(publicApi, bob);
      const aliceAccount = await provisionAccount(aliceApi);
      const bobAccount = await provisionAccount(bobApi);

      const ownerWorkspace = await aliceApi.newGadget();
      const { id: gadgetId } = await ownerWorkspace.getMetadata();
      const collaborator = await ownerWorkspace.addCollaborator(bob, "build");
      if (!collaborator) throw new Error(`Failed to share the gadget with ${bob}`);
      ownerWorkspace[Symbol.dispose]();

      // No ObserverConfigCallback is supplied. Opening can only succeed if the Workshop discovers
      // Bob's ambient account itself; the fixture records which account's verifier it receives.
      using sharedWorkspace = await bobApi.openGadget(gadgetId);
      await expect(sharedWorkspace.getMetadata()).resolves.toMatchObject({
        id: gadgetId,
      });
      expect(await ambientVerificationCount(accountLabel(bobAccount))).toBe(1);
      expect(await ambientVerificationCount(accountLabel(aliceAccount))).toBe(0);
    });
  });

  it.concurrent("prompts once on the collaborator's first open, with no failure attached", async () => {
    await withSession(async (publicApi) => {
      const shared = await shareGadgetWithBob(publicApi, ["first"]);
      const recorder = new ObserverConfigRecorder().alwaysChoose(
        shared.bobAccount.id,
        MAX_OBSERVER_PROMPTS,
      );
      using overseer = await bobOpens(shared, recorder);

      expect(recorder.callCount).toBe(1);
      const need = recorder.needAt(0);
      expect(need.vendorId).toBe(TEST_VENDOR_ID);
      expect(need.failure).toBeUndefined();
      await expect(overseer.getMetadata()).resolves.toMatchObject({
        id: shared.gadgetId,
      });
    });
  });

  it.concurrent("re-prompts with the failed account when verification fails since the last open", async () => {
    await withSession(async (publicApi) => {
      const shared = await shareGadgetWithBob(publicApi, ["expire"]);
      // First open persists Bob's account choice, which is the state the bug lives in.
      expect((await bobOpensAndCloses(shared)).callCount).toBe(1);

      await shared.failBob(EXPIRED_REASON);

      // Second open: the choice is already persisted, so previously no prompt was built at all and the
      // open dead-ended. Now the overseer must re-prompt and say which account failed. Answering with
      // the same still-failing account spends the re-prompt budget, so the open then rejects.
      const second = new ObserverConfigRecorder().alwaysChoose(
        shared.bobAccount.id,
        MAX_OBSERVER_PROMPTS,
      );
      await expect(bobOpens(shared, second)).rejects.toThrow(/could not confirm/i);

      expect(second.callCount).toBe(1);
      const need = second.needAt(0);
      expect(need.failure).toBeDefined();
      expect(need.failure!.accountId).toBe(shared.bobAccount.id);
      expect(need.failure!.reason).toContain(EXPIRED_REASON);
    });
  });

  it.concurrent("names the connection and account when the re-prompt budget is spent", async () => {
    await withSession(async (publicApi) => {
      const shared = await shareGadgetWithBob(publicApi, ["named"]);
      await bobOpensAndCloses(shared);
      await shared.failBob(EXPIRED_REASON);

      const second = new ObserverConfigRecorder().alwaysChoose(
        shared.bobAccount.id,
        MAX_OBSERVER_PROMPTS,
      );
      const error = await bobOpens(shared, second).then(
        (overseer) => {
          overseer[Symbol.dispose]();
          return null;
        },
        (err: unknown) => err as Error,
      );

      expect(error).not.toBeNull();
      // The whole point of the change: the failure is attributable. It names the binding, Bob's own
      // account label, and the gatekeeper's own reason -- not an anonymous refusal.
      expect(error!.message).toContain("Test Thing named");
      expect(error!.message).toContain(shared.bobLabel);
      expect(error!.message).toContain(EXPIRED_REASON);
      // One line per failed binding, so a single failure must not introduce stray newlines.
      expect(error!.message.split("\n").filter((l) => l.includes(shared.bobLabel))).toHaveLength(1);
    });
  });

  it.concurrent("reports every failing binding in one re-prompt, not just the first", async () => {
    await withSession(async (publicApi) => {
      const shared = await shareGadgetWithBob(publicApi, ["multi-a", "multi-b"]);

      // Both bindings were uncovered on the first open, so both were asked about at once.
      const first = await bobOpensAndCloses(shared);
      expect(first.calls[0]).toHaveLength(2);

      await shared.failBob(EXPIRED_REASON);

      // Both bindings now fail in the same verification pass. The old code kept only the first error
      // and dropped the rest, so a second failing connection was invisible.
      const second = new ObserverConfigRecorder().alwaysChoose(
        shared.bobAccount.id,
        MAX_OBSERVER_PROMPTS,
      );
      const error = await bobOpens(shared, second).then(
        (overseer) => {
          overseer[Symbol.dispose]();
          return null;
        },
        (err: unknown) => err as Error,
      );

      expect(second.callCount).toBe(1);
      const needs = second.calls[0];
      expect(needs).toHaveLength(2);
      for (const need of needs) {
        expect(need.failure?.accountId).toBe(shared.bobAccount.id);
      }
      // And the terminal message accounts for both, one line each.
      expect(error!.message).toContain("Test Thing multi-a");
      expect(error!.message).toContain("Test Thing multi-b");
      expect(error!.message.split("\n").filter((l) => l.includes(shared.bobLabel))).toHaveLength(2);
    });
  });

  it.concurrent("denies terminally with no prompt when the client offers no config channel", async () => {
    // The path a collaborator hits by favouriting or sharing a workspace from the sidebar, where
    // openGadget() is called without a callback. This message is the only thing they ever see.
    //
    // Uses a settled denial rather than an expiry, since there is nothing to repair here anyway.
    await withSession(async (publicApi) => {
      const shared = await shareGadgetWithBob(publicApi, ["nocb"]);
      await bobOpensAndCloses(shared);
      await shared.failBob(DENIED_REASON);

      const error = await shared.bobApi.openGadget(shared.gadgetId).then(
        () => null,
        (err: unknown) => err as Error,
      );

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/could not confirm/i);
      expect(error!.message).toContain(DENIED_REASON);
    });
  });
});

describe("harness", () => {
  it.concurrent("serves the Workshop worker", async () => {
    const res = await harness.server.fetch("/");
    expect(res.status).toBeLessThan(500);
  });

  it.concurrent("accepts an RPC session and reports server config", async () => {
    await withSession(async (publicApi) => {
      const config = await publicApi.getServerConfig();
      expect(config.signupsEnabled).toBe(true);
    });
  });

  it.concurrent("provisions a test-gatekeeper account with no auth flow", async () => {
    await withSession(async (publicApi) => {
      const [name] = nextUsernames("smoke");
      using api = await signUp(publicApi, name);
      const account = await provisionAccount(api);

      expect(account.vendorId).toBe(TEST_VENDOR_ID);
      expect(account.credentialsValid).toBe(true);
      expect(account.description.uniqueName).toMatch(/^test-[0-9a-f]{12}@gadgets-test\.example$/);
    });
  });

  it.concurrent("routes a Worker's own outbound fetch through the interceptor", async () => {
    // The negative half of the isolation guarantee. Every other test asserts that *no* unmocked
    // request happened, which would be equally true if Worker subrequests bypassed the patched
    // globalThis.fetch entirely and went straight out. So provoke one and check it was caught.
    //
    // The target is deliberately a real, resolvable host: pointing at something like .invalid would
    // fail whether or not the interception worked, which proves nothing.
    const target = "https://example.com/definitely-not-mocked";
    const res = await harness.fetchWorker(
      TEST_GATEKEEPER_WORKER,
      "http://gatekeeper-test.test/control/fetch-probe",
      { method: "POST", body: JSON.stringify({ url: target }) },
    );

    // The interceptor's throw doesn't surface as a rejection inside the Worker: the harness proxies
    // outbound requests, and a proxy-side failure comes back as a synthetic 500. Either way the
    // request never left the machine, and example.com never answered 500.
    expect(await res.json()).toEqual({ status: 500 });

    // The recording is the actual proof that our handler chain saw it. Take just this entry, so
    // afterAll's assertion still catches anything a sibling let escape.
    expect(interceptor.takeUnmockedCalls(target)).toEqual([`GET ${target}`]);
  });
});
