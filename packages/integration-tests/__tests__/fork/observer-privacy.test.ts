// Observer readiness and privacy -- Knitli fork tests.
//
// Split out of the upstream `observer-reverification.test.ts` so the fork's cases live in a file
// upstream does not have. That file is under active upstream development; every line we added to it
// conflicted on each sync and none of it needed to be there. See docs/fork-maintenance.md.
//
// These cover the privacy-readiness work: an observer's admission must not be published while a
// collaborator's scope is still in doubt, concurrent admissions must serialize, and a session whose
// connection becomes bound mid-flight must be refused rather than quietly retained.
//
// Nothing is stubbed but the network. The real workshop-backend runs under wrangler, tests speak
// Cap'n Web over a WebSocket to /api exactly as the browser does, and the gatekeeper is a real
// Worker speaking the real protocol (see fixtures/gatekeeper-test/src/test-gatekeeper.ts). The
// harness here binds the fixture's EXTERNAL_MESSAGE_GATEWAY, which the upstream file does not need.

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
} from "../../src/harness.js";
import { NetworkInterceptor } from "../../src/network-interceptor.js";
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
} from "../../src/rpc-client.js";

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

describe("observer readiness and privacy", () => {
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
      const pendingAction = (await ownerWorkspace.listActions()).entries.find(
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
});
