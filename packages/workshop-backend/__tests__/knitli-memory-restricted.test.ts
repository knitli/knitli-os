// Fork: Knitli Memory's connection may attest the workspace audience (AUDIENCE_VENDORS in
// src/fork/workspace-audience.ts). The memory facet reads the restricted-data latch at submit and
// again at apply, and refuses OS writes once the workspace has read restricted data. These pin the
// host half against a real overseer: the latch is visible to a memory connection, read fresh at
// apply, and suspends auto-approval on a resource (non-ambient) memory connection.

import { describe, expect, it, vi } from "vitest";
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
const CALLER = { from: "agent", chatId: 1 } as const;
// A resource connection to Knitli Memory, attached by hand rather than provided ambiently.
const MEMORY = 1;
const WRITE = { tag: "knitli-memory.write-working", label: "Write to my working memory" };
const REMEMBER_ACTION = {
  title: "Remember a thing", description: "Writes one memory.", descriptionIsComplete: true,
  implementsRevert: false, actionKind: WRITE, autoApprovable: true,
};
const RESTRICTED = { title: "Team memory", description: "d", containsRestrictedData: true };

// The stub facet keeps the queue its session was started with, and at apply time asks the context
// it was handed, as the memory gatekeeper does.
type Facet = { queue?: any, applied: (WorkspaceAudience | string)[] };

async function withWorkspace<T>(
    fn: (impl: any, overseer: any, facet: Facet) => Promise<T>): Promise<T> {
  let stub = env.TEST_OVERSEER.getByName(`knitli-memory-restricted-${crypto.randomUUID()}`);
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
    impl.storage.gatekeepers.put({
      id: MEMORY, resourceTitle: "Knitli Memory", class: {} as any,
      creationSpec: {
        type: "gatekeeper", vendorId: "memory",
        resourceUrl: "https://memory.knitli.app/m/team%2Fx", typeUrlPattern: "https://memory.knitli.app/m/*",
      },
    });

    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    let overseer: any = await instance.open(USER.id, OWNER, notifyClosed);
    try {
      return await fn(impl, overseer, facet);
    } finally {
      overseer[Symbol.dispose]?.();
    }
  });
}

describe("Knitli Memory under the restricted-data latch", () => {
  it("a memory connection attests, and sees the latch after a restricted observation", async () => {
    await withWorkspace(async (impl, overseer, facet) => {
      await (await overseer.getGatekeeperById(MEMORY)).openSession();
      await expect(facet.queue.attestAudience())
          .resolves.toMatchObject({ owner: OWNER, containsRestrictedData: false });

      await impl.authorizeObservation(MEMORY, RESTRICTED, CALLER);
      await expect(facet.queue.attestAudience())
          .resolves.toMatchObject({ owner: OWNER, containsRestrictedData: true });
    });
  });

  it("the apply context reports a latch set between submit and apply", async () => {
    let applied = await withWorkspace(async (impl, overseer, facet) => {
      await impl.submitAction(MEMORY, 0, REMEMBER_ACTION, CALLER);
      await impl.authorizeObservation(MEMORY, RESTRICTED, CALLER);
      let [pending] = [...impl.storage.actions.list()].filter((rec: any) => rec.type === "action");
      await overseer.approveAction(pending.id);
      return facet.applied;
    });
    expect(applied).toEqual([expect.objectContaining({ owner: OWNER, containsRestrictedData: true })]);
  });

  // Enables the rule the way the Auto-approval tab does, optionally latches through a real
  // restricted observation, then queues an auto-approvable remember and lets the drain settle.
  async function rememberWithRule(latched: boolean): Promise<{ states: string[], applies: number }> {
    return await withWorkspace(async (impl, overseer) => {
      let apply = vi.spyOn(impl, "applyPendingAction");
      await overseer.setAutoApprovedActionKind(MEMORY, WRITE);
      if (latched) await impl.authorizeObservation(MEMORY, RESTRICTED, CALLER);
      await impl.submitAction(MEMORY, 0, REMEMBER_ACTION, CALLER);
      // The drainer is single-flight, so this returns at once if submitAction's drain is running;
      // wait for any apply that drain started.
      await impl.drainAutoApprovals(MEMORY);
      await Promise.allSettled(apply.mock.results.map(result => result.value));
      let states = [...impl.storage.actions.list()]
          .filter((rec: any) => rec.type === "action").map((rec: any) => rec.state);
      return { states, applies: apply.mock.calls.length };
    });
  }

  it("an enabled rule auto-applies a remember on a resource connection while unlatched", async () => {
    expect(await rememberWithRule(false)).toEqual({ states: ["approved"], applies: 1 });
  });

  it("an enabled rule leaves a remember pending once latched", async () => {
    expect(await rememberWithRule(true)).toEqual({ states: ["pending"], applies: 0 });
  });
});
