import { expect, it, vi } from "vitest";
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
      const dictated = await overseer.sendChatMessage(
        chatId, "Keep this visible.", null, undefined, undefined, undefined, true,
      );
      expect(await overseer.getChatMessage(chatId, dictated!)).toMatchObject({
        type: "message", message: "Keep this visible.", hasSpeech: true,
      });
      impl.storage.gatekeepers.put({id: 99, class: {}, hasSlashCommands: true});
      impl.getGatekeeperFacet = () => ({
        getSlashCommandProvider() {
          let provider = {
            invoke: async () => ({message: "Deploy production."}),
            [Symbol.dispose]() {},
          };
          return Object.assign(Promise.resolve(provider), {[Symbol.dispose]() {}});
        },
      });
      const slash = await overseer.sendChatMessage(chatId, {
        id: {gatekeeperId: 99, commandId: "deploy"}, args: "now", hasSpeech: true,
      }, null);
      expect(await overseer.getChatMessage(chatId, slash! - 1)).toMatchObject({
        type: "slashCommand", request: {args: "now", hasSpeech: true},
      });
      expect(await overseer.getChatMessage(chatId, slash!)).toMatchObject({
        type: "message", message: "Deploy production.", hasSpeech: true,
      });
      await expect(overseer.sendChatMessage(chatId, "", null)).rejects.toThrow(
          "Cannot send an empty chat message.");
    } finally {
      (overseer as unknown as {[Symbol.dispose]?(): void})[Symbol.dispose]?.();
    }
  });
}, 30000);


it("defers an empty chat title until its first message and preserves explicit titles", async () => {
  const stub = env.TEST_OVERSEER.getByName(`title-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    const impl = (instance as unknown as {impl: any}).impl;
    const user = {type: "user", id: "title-owner", name: "Owner"};
    const client = {id: {toString: () => user.id}};
    const context = {profile: user, quickModel: {provider: "openai", model: "unused"}};
    const title = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
    impl.generateThreadTitle = title;
    await expect(impl.newChat(client, context, "", [{gatekeeperId: 99}])).rejects.toThrow(
        "Cannot send an empty chat message.");
    const chatId = await impl.newChat(client, context, "");
    expect(title).not.toHaveBeenCalled();
    expect(impl.nextChatSequencePeek(chatId)).toBe(0);
    expect(impl.getChatMetaOrThrow(chatId)).toMatchObject({title: "New Chat"});
    await impl.sendChatMessage(client, context, chatId, "Plan the garden");
    expect(title).toHaveBeenCalledExactlyOnceWith(
        chatId, "Plan the garden", context.quickModel, user);
    await impl.sendChatMessage(client, context, chatId, "Add tomatoes");
    expect(title).toHaveBeenCalledTimes(1);

    const renamedId = await impl.newChat(client, context, "   ");
    impl.storage.chatMeta.put({...impl.getChatMetaOrThrow(renamedId), title: "My garden"});
    await impl.sendChatMessage(client, context, renamedId, "Plan flowers");
    expect(title).toHaveBeenCalledTimes(1);
    expect(impl.getChatMetaOrThrow(renamedId).title).toBe("My garden");

    for (const deferred of [false, true]) {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({
        fileId: id, data: new Uint8Array([65]),
        state: {type: "staged", uploadedAt: Date.now(), mimeType: "text/plain", name: "notes.txt"},
      });
      const attachmentChat = await impl.newChat(
          client, context, "", undefined, deferred ? undefined : [{id}]);
      if (deferred) await impl.sendChatMessage(
          client, context, attachmentChat, "", undefined, [{id}]);
      expect(title).toHaveBeenLastCalledWith(
          attachmentChat, "[user attached 1 attachment(s)]", context.quickModel, user);
    }

    const immediateId = await impl.newChat(client, context, "Plan the kitchen");
    expect(title).toHaveBeenLastCalledWith(
        immediateId, "Plan the kitchen", context.quickModel, user);
    await expect(impl.sendChatMessage(client, context, immediateId, "")).rejects.toThrow(
        "Cannot send an empty chat message.");
  });
}, 30000);


it("preserves a manual rename while the generated title is pending", async () => {
  const stub = env.TEST_OVERSEER.getByName(`title-race-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    const impl = (instance as unknown as {impl: any}).impl;
    const user = {type: "user", id: "title-owner", name: "Owner"};
    const chatId = await impl.newChat({id: {toString: () => user.id}}, {profile: user}, "");
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      impl.storage.chatMeta.put({...impl.getChatMetaOrThrow(chatId), title: "My title"});
      const chunk = {choices: [{index: 0, delta: {role: "assistant", content: "Generated title"},
        finish_reason: "stop"}]};
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: {"content-type": "text/event-stream"},
      });
    }) as typeof fetch;
    try {
      await impl.generateThreadTitle(chatId, "Plan a garden", {
        provider: "cloudflare", model: "@cf/zai-org/glm-5.3-flash",
        accountId: "test-account", apiToken: "test-token",
      }, user);
      expect(calls).toBe(1);
      expect(impl.getChatMetaOrThrow(chatId).title).toBe("My title");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}, 30000);
