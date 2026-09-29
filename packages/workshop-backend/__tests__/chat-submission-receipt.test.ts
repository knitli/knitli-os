import { expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

it("returns the committed prompt sequence, not an earlier message or a command event", async () => {
  const user: AiChatAuthorInfo = {type: "user", id: "receipt-owner", name: "Owner"};
  const stub = env.TEST_OVERSEER.getByName(`receipt-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    const impl = (instance as unknown as {impl: any}).impl;
    impl.ownerId = user.id;
    impl.storage.ownerId.put(user.id);
    const userStub = {
      id: {toString: () => user.id},
      whoami: async () => user,
      getChatContext: async () => ({profile: user}),
      setGadgetLastActive: async () => {},
    };
    impl.users = {idFromString: (id: string) => id, get: () => userStub};
    impl.ensureAmbientCapsules = async () => {};
    impl.syncOutputsTo = async () => true;
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    const overseer = await instance.open(user.id, "owner-profile", notifyClosed);
    try {
      const chatId = await overseer.newChat("same text", null);
      const first = await overseer.sendChatMessage(chatId, "same text", null);
      expect(first).toEqual(expect.any(Number));
      expect(await overseer.getChatMessage(chatId, first!)).toMatchObject({
        chatId, sequence: first, type: "message", message: "same text", author: user,
      });
      const command = await overseer.sendChatMessage(chatId, {
        id: {builtin: true, commandId: "compact"}, args: "",
      }, null);
      expect(command).toBeUndefined();
      expect(await overseer.getChatMessage(chatId, first! + 1)).toMatchObject({
        type: "slashCommand",
      });
      const second = await overseer.sendChatMessage(chatId, "same text", null);
      expect(second).toBe(first! + 2);
      expect(await overseer.getChatMessage(chatId, second!)).toMatchObject({
        sequence: second, type: "message", message: "same text",
      });
      await expect(overseer.sendChatMessage(chatId, "", null)).rejects.toThrow(
          "Cannot send an empty chat message.");
    } finally {
      (overseer as unknown as {[Symbol.dispose]?(): void})[Symbol.dispose]?.();
    }
  });
}, 30000);
