import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AiChatAuthorInfo, AiChatMessage, PromptRef,
} from "@gadgets/workshop-shared/api";
import { ADMIN_CONFIG_KEY } from "../src/blueprint-archive.js";
import {
  DEFAULT_ADMIN_CONFIG, formatInstanceInstructions, parseAdminConfig,
  serializeAdminConfig,
} from "../src/admin-config.js";
import type { AdminSettings } from "../src/admin-settings.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import {
  runAgent, COMMUNICATION_GUIDANCE, SYSTEM_PROMPT, type AgentHooks,
} from "../src/agent.js";
import type { ModelHandle } from "../src/ai-models.js";
import type {
  Api, AssistantMessageEventStream, Model,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  }
}

// Slice 2 (global prompt presets + swap) pins: tolerant preset parsing, the admin CRUD
// round-trip through a real AdminSettings DO (including the KV mirror write), the
// setChatPrompt/newChat/listPromptPresets RPC round-trips through a real owner-opened Overseer,
// and the static-slot swap -- run end to end against the real pi loop with a capturing handle,
// asserting the default against the live SYSTEM_PROMPT constant (not a copy).

const USER: AiChatAuthorInfo = { type: "user", id: "prompt-owner", name: "Owner" };
const AGENT: AiChatAuthorInfo =
    { type: "agent", id: "@cf/zai-org/glm-5.3-flash", name: "GLM" };
const GLM_FLASH = "@cf/zai-org/glm-5.3-flash";
const PRESET_TEXT = "You are a terse code reviewer. Answer in bullet points only.";
const INSTRUCTIONS = "Always sign off as the night-shift crew.";

function adminConfigJson(promptPresets: unknown): string {
  return serializeAdminConfig({...DEFAULT_ADMIN_CONFIG, promptPresets: promptPresets as never});
}

describe("prompt preset parsing", () => {
  it("keeps well-formed presets and drops malformed and duplicate entries", () => {
    let config = parseAdminConfig(adminConfigJson([
      {id: "a", name: "Reviewer", text: "Review."},
      {id: "", name: "Blank id", text: "x"},
      {id: "b", name: "  ", text: "x"},
      {id: "c", name: "No text", text: "   "},
      {id: "a", name: "Dupe id", text: "Other."},
      "not-an-object",
      null,
      {id: 42, name: "Numeric id", text: "x"},
    ]));
    expect(config.promptPresets).toEqual([{id: "a", name: "Reviewer", text: "Review."}]);
  });

  it("defaults presets to empty for missing and non-array values", () => {
    expect(parseAdminConfig(null).promptPresets).toEqual([]);
    expect(parseAdminConfig(adminConfigJson("nope")).promptPresets).toEqual([]);
    expect(parseAdminConfig(adminConfigJson(undefined)).promptPresets).toEqual([]);
    expect(parseAdminConfig("not json").promptPresets).toEqual([]);
  });
});

describe("admin preset CRUD", () => {
  it("round-trips create/update/delete and mirrors to KV", async () => {
    let stub = env.TEST_ADMIN_SETTINGS.getByName(`prompt-crud-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: AdminSettings) => {
      let mirrored: Record<string, string> = {};
      (instance as any).env = {
        ...(instance as any).env,
        BLUEPRINTS: {
          get: async (key: string) => mirrored[key] ?? null,
          put: async (key: string, value: string) => { mirrored[key] = value; },
        },
      };

      expect(await instance.getAdminConfig().promptPresets).toEqual([]);

      let created = await instance.createPromptPreset("  Reviewer  ", "  Review.  ");
      expect(created.id).toBeTruthy();
      // Stored trimmed.
      expect(created).toEqual({id: created.id, name: "Reviewer", text: "Review."});
      expect(await instance.getAdminConfig().promptPresets).toEqual([created]);
      // The KV mirror carries the new list.
      expect(parseAdminConfig(mirrored[ADMIN_CONFIG_KEY]).promptPresets).toEqual([created]);

      await instance.updatePromptPreset(created.id, {name: "Senior reviewer"});
      let updated = await instance.getAdminConfig().promptPresets;
      expect(updated).toEqual([{id: created.id, name: "Senior reviewer", text: "Review."}]);

      // Blank patch values are ignored, not stored.
      await instance.updatePromptPreset(created.id, {name: "   ", text: ""});
      expect(await instance.getAdminConfig().promptPresets).toEqual(updated);

      await expect(instance.updatePromptPreset("missing", {name: "x"}))
          .rejects.toThrow("No such prompt preset.");
      await expect(instance.createPromptPreset("  ", "x")).rejects.toThrow("must not be blank");
      await expect(instance.createPromptPreset("x", "  ")).rejects.toThrow("must not be blank");

      await instance.deletePromptPreset(created.id);
      expect(await instance.getAdminConfig().promptPresets).toEqual([]);
    });
  }, 30000);
});

async function withOwnerOverseer(
    promptPresets: {id: string, name: string, text: string}[],
    fn: (overseer: any, impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`chat-prompt-${crypto.randomUUID()}`);
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
    // The test worker binds no BLUEPRINTS KV; the admin mirror is faked instead.
    impl.env = {
      ...impl.env,
      BLUEPRINTS: { get: async () => adminConfigJson(promptPresets) },
    };
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    let overseer = await instance.open(USER.id, "owner-profile", notifyClosed);
    try {
      await fn(overseer, impl);
    } finally {
      (overseer as unknown as { [Symbol.dispose]?(): void })[Symbol.dispose]?.();
    }
  });
}

const FIXTURES = [{id: "preset-1", name: "Reviewer", text: PRESET_TEXT}];

describe("prompt chat metadata", () => {
  it("newChat seeds the prompt preset", async () => {
    await withOwnerOverseer(FIXTURES, async (overseer, impl) => {
      let chatId = await overseer.newChat(
          "hello", null, undefined, undefined, undefined, undefined,
          {kind: "admin", id: "preset-1"});
      expect(impl.storage.chatMeta.get(chatId).promptRef)
          .toEqual({kind: "admin", id: "preset-1"});

      let plainId = await overseer.newChat("hello", null);
      expect("promptRef" in impl.storage.chatMeta.get(plainId)).toBe(false);

      await expect(overseer.newChat(
          "hello", null, undefined, undefined, undefined, undefined,
          {kind: "admin", id: "missing"}))
          .rejects.toThrow("No such prompt preset");
    });
  }, 30000);

  it("setChatPrompt round-trips and null clears", async () => {
    await withOwnerOverseer(FIXTURES, async (overseer, impl) => {
      let chatId = await overseer.newChat("hello", null);
      // The call returns the stamped ref (null when cleared) for the client's cache.
      expect(await overseer.setChatPrompt(chatId, {kind: "admin", id: "preset-1"}))
          .toEqual({kind: "admin", id: "preset-1"});
      expect(impl.storage.chatMeta.get(chatId).promptRef)
          .toEqual({kind: "admin", id: "preset-1"});
      expect(await overseer.setChatPrompt(chatId, null)).toBeNull();
      expect("promptRef" in impl.storage.chatMeta.get(chatId)).toBe(false);

      await expect(overseer.setChatPrompt(chatId, {kind: "admin", id: "missing"}))
          .rejects.toThrow("No such prompt preset");
      await expect(overseer.setChatPrompt(999, {kind: "admin", id: "preset-1"}))
          .rejects.toThrow("No such chatId");
    });
  }, 30000);

  it("listPromptPresets returns id and name only", async () => {
    await withOwnerOverseer(FIXTURES, async (overseer) => {
      expect(await overseer.listPromptPresets()).toEqual([{id: "preset-1", name: "Reviewer"}]);
    });
    await withOwnerOverseer([], async (overseer) => {
      expect(await overseer.listPromptPresets()).toEqual([]);
    });
  }, 30000);

  it("getPromptRefText resolves admin text and undefined for missing ids", async () => {
    await withOwnerOverseer(FIXTURES, async (overseer, impl) => {
      expect(await impl.getPromptRefText({kind: "admin", id: "preset-1"})).toBe(PRESET_TEXT);
      expect(await impl.getPromptRefText({kind: "admin", id: "missing"})).toBeUndefined();
    });
  }, 30000);
});

function userMessage(text: string): AiChatMessage {
  return {
    chatId: 1, sequence: 0, timestamp: new Date(0), author: USER,
    type: "message", message: text,
  };
}

function capturingHandle(captured: {options?: unknown, systemPrompt?: string}[]): ModelHandle {
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
      captured.push({options, systemPrompt: c.systemPrompt});
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => fauxAssistantMessage("done."),
      } as unknown as AssistantMessageEventStream;
    }) as ModelHandle["stream"],
  };
}

function fakeHooks(overrides: {
  instructions?: string,
  presetText?: string | undefined,
  presetCalls?: PromptRef[],
}): AgentHooks {
  return {
    getChatAgentContext: () => ({ chatId: 1 }),
    getChatCodeBase: () => undefined,
    listGadgetInfo: () => [],
    prepareChatBindings: async () => [],
    getInstanceInstructions: async () => overrides.instructions ?? "",
    describeStandardFormats: async () => "",
    listConnectableVendors: async () => [],
    consumeCapturedActions: () => undefined,
    consumeCapturedConnectionRequests: () => [],
    commitAgentStep: async () => false,
    getChatModelData: () => undefined,
    emitChatStreamEvent: () => {},
    getPromptRefText: async (ref: PromptRef) => {
      overrides.presetCalls?.push(ref);
      return overrides.presetText;
    },
  } as unknown as AgentHooks;
}

async function runTurn(captured: {options?: unknown, systemPrompt?: string}[],
                       hooks: AgentHooks, options: {promptRef?: PromptRef}): Promise<void> {
  await runAgent(
      hooks, capturingHandle(captured), 1, AGENT, [userMessage("hi")],
      new AbortController().signal, USER,
      {
        modelConfig: { provider: "cloudflare", model: GLM_FLASH, apiToken: "" },
        measuredTokens: 0,
      },
      options);
}

describe("runAgent prompt swap", () => {
  it("swaps the static slot to the preset text, instructions still appended", async () => {
    let captured: {options?: unknown, systemPrompt?: string}[] = [];
    let presetCalls: PromptRef[] = [];
    let ref: PromptRef = {kind: "admin", id: "preset-1"};
    await runTurn(captured,
        fakeHooks({instructions: INSTRUCTIONS, presetText: PRESET_TEXT, presetCalls}),
        {promptRef: ref});
    expect(captured.length).toBe(1);
    expect(presetCalls).toEqual([ref]);
    expect(captured[0].systemPrompt!.startsWith(
        `${PRESET_TEXT}\n\n${COMMUNICATION_GUIDANCE}\n\n` +
        formatInstanceInstructions(INSTRUCTIONS))).toBe(true);
  }, 30000);

  it("keeps the built-in prompt byte-identical when unset", async () => {
    let captured: {options?: unknown, systemPrompt?: string}[] = [];
    let presetCalls: PromptRef[] = [];
    await runTurn(captured,
        fakeHooks({instructions: INSTRUCTIONS, presetCalls}), {});
    expect(captured.length).toBe(1);
    // The hook is never read for default chats: no KV lookup on the common path.
    expect(presetCalls).toEqual([]);
    expect(captured[0].systemPrompt!.startsWith(
        `${SYSTEM_PROMPT}\n\n${COMMUNICATION_GUIDANCE}\n\n` +
        formatInstanceInstructions(INSTRUCTIONS))).toBe(true);
  }, 30000);

  it("falls back to the built-in prompt when the preset is gone", async () => {
    let captured: {options?: unknown, systemPrompt?: string}[] = [];
    await runTurn(captured, fakeHooks({presetText: undefined}),
        {promptRef: {kind: "admin", id: "preset-gone"}});
    expect(captured.length).toBe(1);
    expect(captured[0].systemPrompt!.startsWith(`${SYSTEM_PROMPT}\n\n`)).toBe(true);
    expect(captured[0].systemPrompt).not.toContain(PRESET_TEXT);
  }, 30000);
});
