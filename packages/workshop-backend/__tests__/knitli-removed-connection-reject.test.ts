// knitli-site#986: rejecting a pending action whose connection was removed settles it and releases
// the agent turn suspended on it. Before, rejectAction reached for the removed connection's facet
// and threw "removed from the workspace", so the action stayed pending with no way to clear it.

import { describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const USER: AiChatAuthorInfo = { type: "user", id: "alice", name: "Alice" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "test-model", name: "Test Model" };
const REMOVED = 1;
const LIVE = 2;
const CHAT_ID = 1;
const GATE = {
  title: "Edit", description: "Needs a human.", descriptionIsComplete: true,
  implementsRevert: false, awaitDecision: true,
};

describe("rejecting an action on a removed connection", () => {
  it("settles it as rejected without the connection, releases its suspended turn, and still notifies a live connection", async () => {
    let stub = env.TEST_OVERSEER.getByName(`removed-reject-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerId = USER.id;
      impl.storage.ownerId.put(USER.id);
      impl.users = {
        idFromString: (id: string) => id,
        get: () => ({ id: { toString: () => USER.id }, whoami: async () => USER }),
      };
      impl.ensureAmbientCapsules = async () => {};
      impl.syncOutputsTo = async () => true;
      // The live connection's facet is a fake; a removed one goes through the real lookup.
      let liveReject = vi.fn(async () => {});
      let realFacet = impl.getGatekeeperFacet.bind(impl);
      impl.getGatekeeperFacet = vi.fn((id: number) =>
        id === LIVE ? { rejectAction: liveReject } : realFacet(id));
      for (let id of [REMOVED, LIVE]) {
        impl.storage.gatekeepers.put({ id, class: {} as any, resourceTitle: `Thing ${id}` });
      }

      using notifyClosed = new NativeRpcStub<() => void>(() => {});
      let overseer: any = await instance.open(USER.id, "owner-profile", notifyClosed);
      try {
        let waited: Promise<unknown>[] = [];
        impl.ctx.waitUntil = (promise: Promise<unknown>) => { waited.push(promise); };

        // A turn suspended on one awaited action against the connection about to be removed.
        let started = new Date("2026-10-25T00:00:00Z");
        impl.storage.chatMeta.put({ id: CHAT_ID, title: "Chat", started, lastActive: started });
        impl.addChatMessages(CHAT_ID, USER, [{ type: "message", message: "Do the thing." }]);
        impl.storage.actions.put({ id: 7, gatekeeperId: REMOVED, type: "action", action: 42,
          createdAt: started, state: "pending", caller: { from: "agent", chatId: CHAT_ID }, description: GATE });
        impl.storage.actions.put({ id: 8, gatekeeperId: LIVE, type: "action", action: 43,
          createdAt: started, state: "pending", caller: { from: "user" }, description: GATE });
        impl.addChatMessages(CHAT_ID, AGENT, [{ type: "action", actionId: 7 }]);
        impl.storage.activeAgents.put({ chatId: CHAT_ID, modelId: AGENT.id,
          initiatorUserId: USER.id, initiator: USER, callbackInitiated: false });

        impl.removeGatekeeper(REMOVED);
        // Approving it still refuses: it cannot apply without its connection.
        await expect(overseer.approveAction(7)).rejects.toThrow(/removed from the workspace/);
        impl.getGatekeeperFacet.mockClear();

        await overseer.rejectAction(7);
        let rejected = impl.storage.actions.get(7);
        expect(rejected.state).toBe("rejected");
        expect(rejected.resolvedBy).toEqual(USER);
        expect([...impl.storage.actions.pendingByGatekeeper.get(REMOVED)]).toEqual([]);
        expect(impl.storage.activeAgents.get(CHAT_ID)).toBeUndefined();
        expect(impl.storage.chatMeta.get(CHAT_ID).activeAgent).toBeUndefined();
        expect(impl.getGatekeeperFacet).not.toHaveBeenCalledWith(REMOVED);
        expect(waited).toHaveLength(0);

        // A live connection is still told, and still drains.
        await overseer.rejectAction(8);
        expect(liveReject).toHaveBeenCalledWith(43);
        expect(impl.storage.actions.get(8).state).toBe("rejected");
        expect(waited).toHaveLength(1);
        await Promise.all(waited);
      } finally {
        overseer[Symbol.dispose]?.();
      }
    });
  }, 30000);
});
