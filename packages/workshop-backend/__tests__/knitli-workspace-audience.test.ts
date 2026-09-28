// Fork: ApprovalQueue.attestAudience() and applyAction()'s context (src/fork/workspace-audience.ts).
// The audience is the owner plus build collaborators the overseer itself has admitted; a stale
// registration on some facet must never count, so these seed the overseer's own state (sharing
// graph, ObserverRecords) and read the answer through a real session queue or apply path handed to
// a stub facet.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub, RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { WorkspaceAudience } from "@gadgets/workshop-shared/gatekeeper";
import { DEFAULT_ADMIN_CONFIG, serializeAdminConfig } from "../src/admin-config.js";
import { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const USER = { type: "user", id: "alice", name: "Alice" } as const;
const OWNER = "owner-profile";
const OWNER_CALLER = { profileId: OWNER, isOwner: true };
// Account-requiring connections, so "build" scope is all three: 1 is a Knitli Messaging connection
// (the one vendor allowed to ask), 2 is some other vendor, 3 is ambient Messaging (the only kind
// whose action kinds can be pre-approved). No gadget binds any of them, so "use" scope is empty.
const MESSAGING = 1;
const OTHER = 2;
const AMBIENT = 3;
const ALL = { [MESSAGING]: 10, [OTHER]: 20, [AMBIENT]: 30 };
const SEND = { tag: "messaging.send", label: "Send a message" };
const SEND_ACTION = {
  title: "Send a message", description: "Sends one message.", descriptionIsComplete: true,
  implementsRevert: false, actionKind: SEND, autoApprovable: true,
};

function addCollaborator(impl: any, sharing: any, id: string, role: "build" | "use",
    accountChoices: { [id: number]: number }): void {
  sharing.addCollaborator({ caller: OWNER_CALLER, profile: { type: "user", id, name: id }, role });
  impl.storage.observers.put(
      { profileId: id, observerId: `obs-${id}`, accountChoices, admittedAs: role });
}

// A stub facet for every connection: it keeps the queue a session was started with, and at apply
// time asks the context it was handed, as a messaging gatekeeper would.
type Facet = { queue?: any, applied: (WorkspaceAudience | string)[] };

// Opens the workspace as its owner, then runs `fn`.
async function withWorkspace<T>(
    fn: (impl: any, overseer: any, facet: Facet, workspaceId: string) => Promise<T>): Promise<T> {
  let stub = env.TEST_OVERSEER.getByName(`knitli-workspace-audience-${crypto.randomUUID()}`);
  return await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = USER.id;
    impl.storage.ownerId.put(USER.id);
    let userStub = {
      id: { toString: () => USER.id },
      whoami: async () => USER,
      recordSharedGadgetOpen: async () => {},
    };
    impl.users = { idFromString: (id: string) => id, get: () => userStub };
    impl.ensureAmbientCapsules = async () => {};
    impl.syncOutputsTo = async () => true;
    let facet: Facet = { applied: [] };
    impl.getGatekeeperFacet = () => ({
      startSession: async (q: any) => { facet.queue = q; return new RpcTarget(); },
      applyAction: async (_action: number, _cache: unknown, context?: any) => {
        if (!context) return void facet.applied.push("no context");
        try {
          facet.applied.push(await context.attestAudience());
        } catch (err) {
          facet.applied.push(`refused: ${(err as Error).message}`);
        }
      },
      addObserver: async () => {},
      removeObserver: async () => {},
    });
    for (let [id, vendorId] of [[MESSAGING, "messaging"], [OTHER, "testvendor"]] as const) {
      impl.storage.gatekeepers.put({
        id, resourceTitle: `Connection ${id}`, class: {} as any,
        creationSpec: {
          type: "gatekeeper", vendorId,
          resourceUrl: `https://example.com/${id}`, typeUrlPattern: "https://*",
        },
      });
    }
    impl.storage.gatekeepers.put({
      id: AMBIENT, class: {} as any, resourceTitle: "Knitli Messaging",
      creationSpec: { type: "ambient", vendorId: "messaging", accountId: 7 },
    });

    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    let overseer: any = await instance.open(USER.id, OWNER, notifyClosed);
    try {
      return await fn(impl, overseer, facet, instance.ctx.id.toString());
    } finally {
      overseer[Symbol.dispose]?.();
    }
  });
}

// The queue a session on `gatekeeperId` was started with.
async function queueFor(overseer: any, facet: Facet, gatekeeperId: number): Promise<any> {
  let client = await overseer.getGatekeeperById(gatekeeperId);
  await client.openSession();
  return facet.queue;
}

// Lets `setup` shape the overseer's state, then asks the Messaging connection's session queue.
function attest(setup: (impl: any, sharing: any) => void | Promise<void>): Promise<{
    audience: WorkspaceAudience, workspaceId: string }> {
  return withWorkspace(async (impl, overseer, facet, workspaceId) => {
    await setup(impl, await impl.getSharingManager());
    let queue = await queueFor(overseer, facet, MESSAGING);
    return { audience: await queue.attestAudience(), workspaceId };
  });
}

describe("attestAudience", () => {
  it("is the owner alone in an unshared workspace", async () => {
    let { audience, workspaceId } = await attest(() => {});
    expect(audience).toEqual({
      workspaceId, owner: OWNER, collaborators: [],
      containsRestrictedData: false, ownerInvitesOnly: false, sharingProhibited: false,
    });
  });

  it("includes admitted build collaborators, never the owner", async () => {
    let { audience } = await attest((impl, sharing) => {
      addCollaborator(impl, sharing, "zed", "build", ALL);
      addCollaborator(impl, sharing, "bob", "build", ALL);
      // A stray record under the owner's own profile id must not list the owner twice.
      impl.storage.observers.put(
          { profileId: OWNER, observerId: "obs-owner", accountChoices: ALL, admittedAs: "build" });
    });
    expect(audience.collaborators).toEqual(["bob", "zed"]);
  });

  it("excludes a use collaborator", async () => {
    let { audience } = await attest((impl, sharing) => {
      addCollaborator(impl, sharing, "bob", "build", ALL);
      addCollaborator(impl, sharing, "dave", "use", ALL);
    });
    expect(audience.collaborators).toEqual(["bob"]);
  });

  it("excludes a build collaborator not yet admitted to every connection", async () => {
    // E.g. a use admission later upgraded to build, or a connection added since they last opened:
    // their record holds no verified choice for connection 2 until their next open.
    let { audience } = await attest((impl, sharing) => {
      addCollaborator(impl, sharing, "bob", "build", ALL);
      addCollaborator(impl, sharing, "erin", "build", { [MESSAGING]: 10, [AMBIENT]: 30 });
    });
    expect(audience.collaborators).toEqual(["bob"]);
  });

  it("excludes a collaborator removed from sharing whose observer record lingers", async () => {
    let { audience } = await attest((impl, sharing) => {
      addCollaborator(impl, sharing, "bob", "build", ALL);
      addCollaborator(impl, sharing, "carol", "build", ALL);
      sharing.removeCollaborator(OWNER_CALLER, "carol", []);
    });
    expect(audience.collaborators).toEqual(["bob"]);
  });

  it("excludes a collaborator downgraded from build to use", async () => {
    let { audience } = await attest((impl, sharing) => {
      addCollaborator(impl, sharing, "bob", "build", ALL);
      addCollaborator(impl, sharing, "carol", "build", ALL);
      downgradeToUse(sharing, "carol");
    });
    expect(audience.collaborators).toEqual(["bob"]);
  });

  // Carol's build admission verified her for connection 2. Downgraded to use, 2 is outside her
  // scope, so an observation on 2 naming her de-registers her from it instead of blocking. That
  // clears her record's build admission (her account choices stay): upgraded back to build, she
  // has not been re-verified for 2 and must not count until her next build open.
  it("excludes a collaborator re-upgraded after an out-of-scope de-registration", async () => {
    let { audience } = await attest(async (impl, sharing) => {
      addCollaborator(impl, sharing, "bob", "build", ALL);
      addCollaborator(impl, sharing, "carol", "build", ALL);
      downgradeToUse(sharing, "carol");
      await impl.authorizeObservation(OTHER,
          { title: "Observation", description: "d", excludeObservers: ["obs-carol"] },
          { from: "agent", chatId: 1 });
      sharing.addCollaborator(
          { caller: OWNER_CALLER, profile: { type: "user", id: "carol", name: "carol" }, role: "build" });
      expect(sharing.getEffectiveRole("carol")).toBe("build");
      // The remembered accounts survive, so her next open re-verifies them without asking.
      expect(impl.storage.observers.get("carol").accountChoices).toEqual(ALL);
    });
    expect(audience.collaborators).toEqual(["bob"]);
  });

  // The persist seam in ensureObserver: a record from before `admittedAs` existed does not count,
  // and a real build admission (every build-scope addObserver passing) makes it count.
  it("counts a collaborator once a build admission has verified them", async () => {
    await withWorkspace(async (impl, overseer, facet) => {
      let sharing = await impl.getSharingManager();
      addCollaborator(impl, sharing, "carol", "build", ALL);
      impl.storage.observers.put({ profileId: "carol", observerId: "obs-carol", accountChoices: ALL });
      let queue = await queueFor(overseer, facet, MESSAGING);
      expect((await queue.attestAudience()).collaborators).toEqual([]);

      await impl.ensureObserver("carol", {
        getVerifier: async () => ({}),
        listProvidedAccounts: async () => [],
        describeConnectedAccount: async () => null,
      }, "build");
      expect((await queue.attestAudience()).collaborators).toEqual(["carol"]);
    });
  });

  // A build open captures her role when it begins and can park (account prompts, verifier RPCs)
  // while #enforceExcludeObservers, which does not wait for admissions, runs. Here the open
  // registers her on connection 2 at once and parks on the Messaging connections' verifiers;
  // meanwhile `during` runs; then the open completes and persists her record.
  async function admitAcross(during: (impl: any, sharing: any) => Promise<void>): Promise<string[]> {
    return await withWorkspace(async (impl, overseer, facet) => {
      let sharing = await impl.getSharingManager();
      addCollaborator(impl, sharing, "bob", "build", ALL);
      addCollaborator(impl, sharing, "carol", "build", ALL);
      let release!: () => void;
      let gate = new Promise<void>(resolve => { release = resolve; });
      let parked!: () => void;
      let reached = new Promise<void>(resolve => { parked = resolve; });
      let open = impl.ensureObserver("carol", {
        getVerifier: async (_accountId: number, vendorId: string) => {
          if (vendorId === "messaging") { parked(); await gate; }
          return {};
        },
        listProvidedAccounts: async () => [],
        describeConnectedAccount: async () => null,
      }, "build");
      await reached;
      await during(impl, sharing);
      release();
      await open;
      sharing.addCollaborator(
          { caller: OWNER_CALLER, profile: { type: "user", id: "carol", name: "carol" }, role: "build" });
      let queue = await queueFor(overseer, facet, MESSAGING);
      return (await queue.attestAudience()).collaborators;
    });
  }

  it("excludes her when a de-registration lands during her build open", async () => {
    // Downgraded and de-registered from 2 after the open registered her there, then upgraded
    // again before the open persists: her role reads "build" at the put, but the registration the
    // open made on 2 is gone.
    expect(await admitAcross(async (impl, sharing) => {
      downgradeToUse(sharing, "carol");
      await impl.authorizeObservation(OTHER,
          { title: "Observation", description: "d", excludeObservers: ["obs-carol"] },
          { from: "agent", chatId: 1 });
      sharing.addCollaborator(
          { caller: OWNER_CALLER, profile: { type: "user", id: "carol", name: "carol" }, role: "build" });
    })).toEqual(["bob"]);
  });

  it("excludes her when her role changes during her build open", async () => {
    // Conservative: nothing was torn down, but the admission no longer matches her role.
    expect(await admitAcross(async (_impl, sharing) => downgradeToUse(sharing, "carol")))
        .toEqual(["bob"]);
  });

  it("counts her when nothing changes during her build open", async () => {
    expect(await admitAcross(async () => {})).toEqual(["bob", "carol"]);
  });

  it("refuses while a revocation is in flight", async () => {
    await withWorkspace(async (impl, overseer, facet) => {
      let queue = await queueFor(overseer, facet, MESSAGING);
      impl.beginRevocation();
      await expect(queue.attestAudience()).rejects.toThrow(/access is changing/);
      impl.finishRevocationWithoutEffect();
      await expect(queue.attestAudience()).resolves.toMatchObject({ owner: OWNER });
    });
  });

  it("refuses a connection whose vendor is not allowlisted", async () => {
    await withWorkspace(async (_impl, overseer, facet) => {
      let queue = await queueFor(overseer, facet, OTHER);
      await expect(queue.attestAudience()).rejects.toThrow(/not permitted to attest/);
    });
  });

  it("reflects the workspace latches, and names nobody else once sharing is prohibited", async () => {
    let { audience } = await attest((impl, sharing) => {
      addCollaborator(impl, sharing, "bob", "build", ALL);
      impl.storage.containsRestrictedData.put(true);
      impl.storage.ownerInvitesOnly.put(true);
      impl.storage.prohibitWorkspaceSharing.put(true);
    });
    expect(audience).toMatchObject({
      collaborators: [], containsRestrictedData: true, ownerInvitesOnly: true,
      sharingProhibited: true,
    });
  });

  it("reports an owner-only connection as sharing-prohibited", async () => {
    let { audience } = await attest(impl => {
      let record = impl.storage.gatekeepers.get(OTHER);
      impl.storage.gatekeepers.put({ ...record, ownerOnly: true });
    });
    expect(audience).toMatchObject(
        { containsRestrictedData: false, ownerInvitesOnly: false, sharingProhibited: true });
  });
});

function downgradeToUse(sharing: any, id: string): void {
  sharing.removeCollaborator(OWNER_CALLER, id, []);
  sharing.addCollaborator({ caller: OWNER_CALLER, profile: { type: "user", id, name: id }, role: "use" });
}

// A gatekeeper that moves data out re-checks the audience when the action is applied, which can be
// long after it was queued. Carol is removed in between; the apply-time answer must drop her.
describe("applyAction's context", () => {
  async function submitThenRemoveCarol(impl: any, gatekeeperId: number): Promise<void> {
    let sharing = await impl.getSharingManager();
    addCollaborator(impl, sharing, "bob", "build", ALL);
    addCollaborator(impl, sharing, "carol", "build", ALL);
    await impl.submitAction(gatekeeperId, 0, SEND_ACTION, { from: "user" });
    sharing.removeCollaborator(OWNER_CALLER, "carol", []);
  }

  async function approveManually(gatekeeperId: number): Promise<Facet["applied"]> {
    return await withWorkspace(async (impl, overseer, facet) => {
      await submitThenRemoveCarol(impl, gatekeeperId);
      let [pending] = [...impl.storage.actions.list()].filter((rec: any) => rec.type === "action");
      await overseer.approveAction(pending.id);
      return facet.applied;
    });
  }

  it("attests the apply-time audience on manual approval", async () => {
    expect(await approveManually(MESSAGING))
        .toEqual([expect.objectContaining({ owner: OWNER, collaborators: ["bob"] })]);
  });

  it("attests the apply-time audience on auto-approval", async () => {
    let applied = await withWorkspace(async (impl, overseer, facet) => {
      await submitThenRemoveCarol(impl, AMBIENT);
      await overseer.setAutoApprovedActionKind(AMBIENT, SEND);
      // The drainer is single-flight: this joins the drain setAutoApprovedActionKind started.
      await impl.drainAutoApprovals(AMBIENT);
      return facet.applied;
    });
    expect(applied).toEqual([expect.objectContaining({ owner: OWNER, collaborators: ["bob"] })]);
  });

  it("refuses a connection whose vendor is not allowlisted", async () => {
    expect(await approveManually(OTHER)).toEqual([expect.stringMatching(/not permitted to attest/)]);
  });
});

// Mirrors overseer-hooks.test.ts "a firing's approval queue refuses once the hook is disabled": a
// hook firing's queue revalidates the hook per call, attestAudience included.
describe("a hook firing's queue", () => {
  it("refuses attestAudience once the hook is disabled", async () => {
    let hook = { enabled: true, vendorId: "messaging", callback: {} };
    let overseer = Object.create(OverseerDurableObject.prototype) as OverseerDurableObject;
    Object.assign(overseer, {
      env: { BLUEPRINTS: { get: async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG) } },
      impl: {
        assertGatekeeperUsable: () => {},
        storage: {
          boundHooks: { get: () => ({ ...hook, gatekeeperId: 1 }) },
          gatekeepers: { get: () => undefined },
        },
        assertGatekeeperObserverReadiness: async () => {},
      },
    });
    let { approvalQueue } = await overseer.startHook(1);

    hook.enabled = false;

    expect(() => approvalQueue.attestAudience!()).toThrow(/deleted or disabled/);
  });
});
