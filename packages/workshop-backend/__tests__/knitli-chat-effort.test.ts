import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AiChatAuthorInfo, AiChatMessage,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import { runAgent, type AgentHooks } from "../src/agent.js";
import type { ModelHandle } from "../src/ai-models.js";
import type {
  Api, AssistantMessageEventStream, Model,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Slice 1 (per-chat effort override) pins: the setChatEffort/newChat RPC round-trips through a
// real owner-opened Overseer (validation included), and the turn-start threading of the override
// into the agent loop's stream options -- run end to end against the real pi loop with a
// capturing handle, asserting both that an explicit effort arrives and that an unset one leaves
// the key absent (an explicit undefined would clobber makeHandle's per-API defaults).

const USER: AiChatAuthorInfo = { type: "user", id: "effort-owner", name: "Owner" };
const AGENT: AiChatAuthorInfo =
    { type: "agent", id: "@cf/zai-org/glm-5.3-flash", name: "GLM" };
const GLM_FLASH = "@cf/zai-org/glm-5.3-flash";

async function withOwnerOverseer(
    fn: (overseer: any, impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`chat-effort-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = USER.id;
    impl.storage.ownerId.put(USER.id);
    let userStub = {
      id: { toString: () => USER.id },
      whoami: async () => USER,
      getChatContext: async () => ({ profile: USER }),
      setGadgetLastActive: async () => {},
    };
    impl.users = { idFromString: (id: string) => id, get: () => userStub };
    impl.ensureAmbientCapsules = async () => {};
    impl.syncOutputsTo = async () => true;
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    let overseer = await instance.open(USER.id, "owner-profile", notifyClosed);
    try {
      await fn(overseer, impl);
    } finally {
      (overseer as unknown as { [Symbol.dispose]?(): void })[Symbol.dispose]?.();
    }
  });
}

describe("effort chat metadata", () => {
  it("newChat seeds the effort override", async () => {
    await withOwnerOverseer(async (overseer, impl) => {
      let chatId = await overseer.newChat(
          "hello", null, undefined, undefined, undefined, "high");
      expect(impl.storage.chatMeta.get(chatId).reasoningEffort).toBe("high");

      let plainId = await overseer.newChat("hello", null);
      expect("reasoningEffort" in impl.storage.chatMeta.get(plainId)).toBe(false);
    });
  }, 30000);

  it("setChatEffort round-trips and null clears", async () => {
    await withOwnerOverseer(async (overseer, impl) => {
      let chatId = await overseer.newChat("hello", null);
      await overseer.setChatEffort(chatId, "low");
      expect(impl.storage.chatMeta.get(chatId).reasoningEffort).toBe("low");
      await overseer.setChatEffort(chatId, null);
      expect("reasoningEffort" in impl.storage.chatMeta.get(chatId)).toBe(false);
    });
  }, 30000);

  it("rejects invalid levels and unknown chats", async () => {
    await withOwnerOverseer(async (overseer, impl) => {
      let chatId = await overseer.newChat("hello", null);
      await expect(overseer.setChatEffort(chatId, "ultra")).rejects.toThrow(
          "Invalid reasoning effort");
      await expect(overseer.newChat(
          "hello", null, undefined, undefined, undefined, "ultra")).rejects.toThrow(
          "Invalid reasoning effort");
      await expect(overseer.setChatEffort(999, "low")).rejects.toThrow("No such chatId");
      // Failed writes leave no trace.
      expect("reasoningEffort" in impl.storage.chatMeta.get(chatId)).toBe(false);
    });
  }, 30000);
});

function userMessage(text: string): AiChatMessage {
  return {
    chatId: 1, sequence: 0, timestamp: new Date(0), author: USER,
    type: "message", message: text,
  };
}

function capturingHandle(captured: unknown[]): ModelHandle {
  let model: Model<Api> = {
    id: GLM_FLASH,
    name: "GLM",
    api: "openai-completions",
    provider: "cloudflare-workers-ai",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32768,
  };
  return {
    model,
    stream: ((m, c, options) => {
      captured.push(options);
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => fauxAssistantMessage("done."),
      } as unknown as AssistantMessageEventStream;
    }) as ModelHandle["stream"],
  };
}

// Only the hooks a gadget-free, text-only turn reaches; anything else throws loudly.
function fakeHooks(): AgentHooks {
  return {
    getChatAgentContext: () => ({ chatId: 1 }),
    getChatCodeBase: () => undefined,
    listGadgetInfo: () => [],
    prepareChatBindings: async () => [],
    getInstanceInstructions: async () => "",
    describeStandardFormats: async () => "",
    listConnectableVendors: async () => [],
    consumeCapturedActions: () => undefined,
    consumeCapturedConnectionRequests: () => [],
    commitAgentStep: async () => false,
    getChatModelData: () => undefined,
    emitChatStreamEvent: () => {},
  } as unknown as AgentHooks;
}

describe("runAgent effort threading", () => {
  it("forwards an explicit effort to the stream options", async () => {
    let captured: unknown[] = [];
    await runAgent(
        fakeHooks(), capturingHandle(captured), 1, AGENT, [userMessage("hi")],
        new AbortController().signal, USER, false,
        {
          modelConfig: { provider: "cloudflare", model: GLM_FLASH, apiToken: "" },
          measuredTokens: 0,
        },
        { reasoningEffort: "high" });
    expect(captured.length).toBe(1);
    expect(captured[0]).toMatchObject({ reasoningEffort: "high" });
  }, 30000);

  it("leaves the effort key absent when no override is set", async () => {
    let captured: unknown[] = [];
    await runAgent(
        fakeHooks(), capturingHandle(captured), 1, AGENT, [userMessage("hi")],
        new AbortController().signal, USER, false,
        {
          modelConfig: { provider: "cloudflare", model: GLM_FLASH, apiToken: "" },
          measuredTokens: 0,
        },
        {});
    expect(captured.length).toBe(1);
    expect("reasoningEffort" in (captured[0] as Record<string, unknown>)).toBe(false);
  }, 30000);
});
