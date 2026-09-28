// Fork: ApprovalQueue.attestAudience() (src/fork/workspace-audience.ts). The audience is the owner
// plus build collaborators the overseer itself has admitted; a stale registration on some facet
// must never count, so these seed the overseer's own state (sharing graph, ObserverRecords) and
// read the answer through a real session queue handed to a stub facet.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub, RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { WorkspaceAudience } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const USER = { type: "user", id: "alice", name: "Alice" } as const;
const OWNER = "owner-profile";
const OWNER_CALLER = { profileId: OWNER, isOwner: true };
// Account-requiring connections: "build" scope is all three.
const GATEKEEPERS = [1, 2];
const AMBIENT = 3;
const BOTH = { 1: 10, 2: 20, [AMBIENT]: 30 };
const SEND = { tag: "messaging.send", label: "Send a message" };
const SEND_ACTION = {
  title: "Send a message", description: "Sends one message.", descriptionIsComplete: true,
  implementsRevert: false, actionKind: SEND, autoApprovable: true,
};

function addCollaborator(impl: any, sharing: any, id: string, role: "build" | "use",
    accountChoices: { [id: number]: number }): void {
  sharing.addCollaborator({ caller: OWNER_CALLER, profile: { type: "user", id, name: id }, role });
  impl.storage.observers.put({ profileId: id, observerId: `obs-${id}`, accountChoices });
}

// A stub facet for every connection: it keeps the queue a session was started with, and at apply
// time asks the context it was handed, as a messaging gatekeeper would.
type Facet = { queue?: any, applied: (WorkspaceAudience | "no context")[] };

// Opens the workspace as its owner with connections 1 and 2 plus an ambient connection 3 (the
// only kind whose action kinds can be pre-approved), then runs `fn`.
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
        facet.applied.push(context ? await context.attestAudience() : "no context");
      },
    });
    for (let id of GATEKEEPERS) {
      impl.storage.gatekeepers.put({
        id, resourceTitle: `Connection ${id}`, class: {} as any,
        creationSpec: {
          type: "gatekeeper", vendorId: "testvendor",
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

// Lets `setup` shape the overseer's state, then asks the queue a session on connection 1 was
// started with.
function attest(setup: (impl: any, sharing: any) => void): Promise<{
    audience: WorkspaceAudience, workspaceId: string }> {
  return withWorkspace(async (impl, overseer, facet, workspaceId) => {
    setup(impl, await impl.getSharingManager());
    let client = await overseer.getGatekeeperById(1);
    await client.openSession();
    return { audience: await facet.queue.attestAudience(), workspaceId };
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
      addCollaborator(impl, sharing, "zed", "build", BOTH);
      addCollaborator(impl, sharing, "bob", "build", BOTH);
      // A stray record under the owner's own profile id must not list the owner twice.
      impl.storage.observers.put({ profileId: OWNER, observerId: "obs-owner", accountChoices: BOTH });
    });
    expect(audience.collaborators).toEqual(["bob", "zed"]);
  });

  it("excludes a use collaborator", async () => {
    let { audience } = await attest((impl, sharing) => {
      addCollaborator(impl, sharing, "bob", "build", BOTH);
      addCollaborator(impl, sharing, "dave", "use", BOTH);
    });
    expect(audience.collaborators).toEqual(["bob"]);
  });

  it("excludes a build collaborator not yet admitted to every connection", async () => {
    // E.g. a use admission later upgraded to build, or a connection added since they last opened:
    // their record holds no verified choice for connection 2 until their next open.
    let { audience } = await attest((impl, sharing) => {
      addCollaborator(impl, sharing, "bob", "build", BOTH);
      addCollaborator(impl, sharing, "erin", "build", { 1: 10 });
    });
    expect(audience.collaborators).toEqual(["bob"]);
  });

  it("excludes a collaborator removed from sharing whose observer record lingers", async () => {
    let { audience } = await attest((impl, sharing) => {
      addCollaborator(impl, sharing, "bob", "build", BOTH);
      addCollaborator(impl, sharing, "carol", "build", BOTH);
      sharing.removeCollaborator(OWNER_CALLER, "carol", []);
    });
    expect(audience.collaborators).toEqual(["bob"]);
  });

  it("excludes a collaborator downgraded from build to use", async () => {
    let { audience } = await attest((impl, sharing) => {
      addCollaborator(impl, sharing, "bob", "build", BOTH);
      addCollaborator(impl, sharing, "carol", "build", BOTH);
      sharing.removeCollaborator(OWNER_CALLER, "carol", []);
      sharing.addCollaborator(
          { caller: OWNER_CALLER, profile: { type: "user", id: "carol", name: "carol" }, role: "use" });
    });
    expect(audience.collaborators).toEqual(["bob"]);
  });

  it("reflects the workspace latches", async () => {
    let { audience } = await attest(impl => {
      impl.storage.containsRestrictedData.put(true);
      impl.storage.ownerInvitesOnly.put(true);
      impl.storage.prohibitWorkspaceSharing.put(true);
    });
    expect(audience).toMatchObject(
        { containsRestrictedData: true, ownerInvitesOnly: true, sharingProhibited: true });
  });

  it("reports an owner-only connection as sharing-prohibited", async () => {
    let { audience } = await attest(impl => {
      let record = impl.storage.gatekeepers.get(2);
      impl.storage.gatekeepers.put({ ...record, ownerOnly: true });
    });
    expect(audience).toMatchObject(
        { containsRestrictedData: false, ownerInvitesOnly: false, sharingProhibited: true });
  });
});

// A gatekeeper that moves data out re-checks the audience when the action is applied, which can be
// long after it was queued. Carol is removed in between; the apply-time answer must drop her.
describe("applyAction's context", () => {
  async function submitThenRemoveCarol(impl: any): Promise<void> {
    let sharing = await impl.getSharingManager();
    addCollaborator(impl, sharing, "bob", "build", BOTH);
    addCollaborator(impl, sharing, "carol", "build", BOTH);
    await impl.submitAction(AMBIENT, 0, SEND_ACTION, { from: "user" });
    sharing.removeCollaborator(OWNER_CALLER, "carol", []);
  }

  it("attests the apply-time audience on manual approval", async () => {
    let applied = await withWorkspace(async (impl, overseer, facet) => {
      await submitThenRemoveCarol(impl);
      let [pending] = [...impl.storage.actions.list()].filter((rec: any) => rec.type === "action");
      await overseer.approveAction(pending.id);
      return facet.applied;
    });
    expect(applied).toEqual([expect.objectContaining({ owner: OWNER, collaborators: ["bob"] })]);
  });

  it("attests the apply-time audience on auto-approval", async () => {
    let applied = await withWorkspace(async (impl, overseer, facet) => {
      await submitThenRemoveCarol(impl);
      await overseer.setAutoApprovedActionKind(AMBIENT, SEND);
      // The drainer is single-flight: this joins the drain setAutoApprovedActionKind started.
      await impl.drainAutoApprovals(AMBIENT);
      return facet.applied;
    });
    expect(applied).toEqual([expect.objectContaining({ owner: OWNER, collaborators: ["bob"] })]);
  });
});
