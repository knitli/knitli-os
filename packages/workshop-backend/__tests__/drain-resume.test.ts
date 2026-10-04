// A drain that auto-applies a user/OpenAPI-caller action resumes the agent turn waiting on
// it, just as a manual approval does: approveAction fans non-agent decisions out to every chat
// whose current turn references the action, and the drain must do the same once the earlier
// manual gate clears.

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
const GATEKEEPER = 1;
const CHAT_ID = 1;
const SEND = { tag: "messaging.send", label: "Send a message" };

const MANUAL_GATE = {
  title: "Manual gate", description: "Needs a human.", descriptionIsComplete: true,
  implementsRevert: false, actionKind: { tag: "messaging.delete", label: "Delete" },
  awaitDecision: true,
};
const AUTO_SEND = {
  title: "Auto send", description: "Sends one message.", descriptionIsComplete: true,
  implementsRevert: false, actionKind: SEND, autoApprovable: true, awaitDecision: true,
};

describe("drain resume for non-agent waiters", () => {
  it("resumes a turn whose last awaited action a drain auto-applies", async () => {
    let stub = env.TEST_OVERSEER.getByName(`drain-resume-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerId = USER.id;
      impl.storage.ownerId.put(USER.id);
      impl.users = {
        idFromString: (id: string) => id,
        get: () => ({
          id: { toString: () => USER.id },
          whoami: async () => USER,
          getChatContext: async () => ({
            profile: USER,
            aiModel: {
              profile: AGENT,
              config: { provider: "openai", model: "test-model", apiToken: "" },
            },
          }),
        }),
      };
      impl.ensureAmbientCapsules = async () => {};
      impl.syncOutputsTo = async () => true;
      let startAgent = vi.fn();
      impl.startAgent = startAgent;
      impl.getGatekeeperFacet = () => ({ applyAction: async () => {} });
      impl.storage.gatekeepers.put({
        id: GATEKEEPER, class: {} as any, resourceTitle: "Knitli Messaging",
        creationSpec: { type: "ambient", vendorId: "messaging", accountId: 7 },
      });

      using notifyClosed = new NativeRpcStub<() => void>(() => {});
      let overseer: any = await instance.open(USER.id, "owner-profile", notifyClosed);
      try {
        // Capture background drains so the test can flush them deterministically.
        let waited: Promise<unknown>[] = [];
        impl.ctx.waitUntil = (promise: Promise<unknown>) => { waited.push(promise); };
        let flushBackground = async () => {
          await Promise.all(waited.splice(0));
        };

        // A suspended turn: no active agent, with agent-authored cards referencing both
        // actions below.
        let started = new Date("2026-10-04T00:00:00Z");
        impl.storage.chatMeta.put({ id: CHAT_ID, title: "Chat", started, lastActive: started });
        impl.addChatMessages(CHAT_ID, USER, [{ type: "message", message: "Do the thing." }]);
        await impl.submitAction(GATEKEEPER, 0, MANUAL_GATE, { from: "user" });
        await impl.submitAction(GATEKEEPER, 0, AUTO_SEND, { from: "user" });
        let [manual, auto] = [...impl.storage.actions.list()]
            .filter((rec: any) => rec.type === "action")
            .toSorted((a: any, b: any) => a.id - b.id);
        impl.addChatMessages(CHAT_ID, AGENT, [
          { type: "action", actionId: manual.id }, { type: "action", actionId: auto.id },
        ]);

        await overseer.setAutoApprovedActionKind(GATEKEEPER, SEND);
        await flushBackground();
        // The drain stops at the manual gate; nothing is applied yet.
        expect(impl.storage.actions.get(auto.id).state).toBe("pending");

        await overseer.approveAction(manual.id);
        await flushBackground();

        expect(impl.storage.actions.get(auto.id).state).toBe("approved");
        expect(impl.storage.chatMeta.get(CHAT_ID).activeAgent).toEqual(AGENT);
        expect(startAgent).toHaveBeenCalledTimes(1);
        expect(startAgent.mock.calls[0]![0]).toBe(CHAT_ID);
      } finally {
        overseer[Symbol.dispose]?.();
      }
    });
  }, 30000);
});
