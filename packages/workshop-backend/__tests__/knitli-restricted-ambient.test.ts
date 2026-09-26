// Upstream #487's restricted mode suspends every auto-approval rule. The fork (#37) lets users
// pre-approve action kinds on ambient (always-on) gatekeepers, which no gadget binds; this pins
// that such a rule is suspended too, through the same autoApprovalRule() gate.

import { describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const CALLER = { from: "user" } as const;
const USER = { type: "user", id: "alice", name: "Alice" } as const;
const WRITE = { tag: "memory.write", label: "Write to my working memory" };
const AMBIENT = 2;

const WRITE_ACTION = {
  title: "Remember a thing", description: "Writes one memory.", descriptionIsComplete: true,
  implementsRevert: false, actionKind: WRITE, autoApprovable: true,
};

function states(impl: any): string[] {
  return [...impl.storage.actions.list()]
      .filter((rec: any) => rec.type === "action")
      .map((rec: any) => rec.state);
}

// Queues one ambient action, then enables its rule the way the Auto-approval tab does
// (setAutoApprovedActionKind on the owner's Overseer), and lets the drain that call starts
// settle. Returns the action states and how often the apply path ran.
async function enableRuleAfterSubmit(restricted: boolean)
    : Promise<{ states: string[], applies: number }> {
  let stub = env.TEST_OVERSEER.getByName(`knitli-restricted-ambient-${crypto.randomUUID()}`);
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
    // A facet whose apply succeeds, so an auto-approval that fires is observable as "approved".
    vi.spyOn(impl, "getGatekeeperFacet").mockReturnValue({ applyAction: async () => {} });
    let apply = vi.spyOn(impl, "applyPendingAction");

    impl.storage.gatekeepers.put({
      id: AMBIENT, class: {} as any, resourceTitle: "Knitli Memory",
      creationSpec: { type: "ambient", vendorId: "memory", accountId: 7 },
    });
    impl.storage.containsRestrictedData.put(restricted);
    await impl.submitAction(AMBIENT, 0, WRITE_ACTION, CALLER);

    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    let overseer: any = await instance.open(USER.id, "owner-profile", notifyClosed);
    try {
      await overseer.setAutoApprovedActionKind(AMBIENT, WRITE);
      // The drainer is single-flight: this joins the drain setAutoApprovedActionKind started.
      await impl.drainAutoApprovals(AMBIENT);
      return { states: states(impl), applies: apply.mock.calls.length };
    } finally {
      overseer[Symbol.dispose]?.();
    }
  });
}

describe("ambient pre-approval under the restricted-data latch", () => {
  it("enabling the rule applies a pending ambient action while unlatched", async () => {
    expect(await enableRuleAfterSubmit(false)).toEqual({ states: ["approved"], applies: 1 });
  });

  it("enabling the rule leaves it pending once latched, never reaching the apply path", async () => {
    expect(await enableRuleAfterSubmit(true)).toEqual({ states: ["pending"], applies: 0 });
  });
});
