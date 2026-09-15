import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AiChatAuthorInfo, AiModelConfig, PromptSelection,
} from "@gadgets/workshop-shared/api";
import {
  DEFAULT_ADMIN_CONFIG, serializeAdminConfig,
} from "../src/admin-config.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import { SYSTEM_PROMPT } from "../src/agent.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Turn-start threading pins: the overseer reads the chat's effort override and prompt preset
// from metadata when a turn starts, and the selections reach the provider request -- run end
// to end through a real Overseer turn (impl.newChat seeds the metadata and starts the turn)
// with the network stubbed, asserting on the captured request bodies. The agent-level halves
// (options -> stream config, ref -> static slot) are pinned in knitli-chat-effort/prompt;
// this file pins the overseer's half: metadata -> options.

const USER: AiChatAuthorInfo = { type: "user", id: "turn-owner", name: "Owner" };
const AGENT: AiChatAuthorInfo =
    { type: "agent", id: "@cf/zai-org/glm-5.3-flash", name: "GLM" };
const GLM_FLASH = "@cf/zai-org/glm-5.3-flash";
const PRESET_TEXT = "You are a terse code reviewer. Answer in bullet points only.";

// Direct Workers AI REST config; credentials are dummies -- fetch is stubbed below.
const CONFIG: AiModelConfig = {
  provider: "cloudflare", model: GLM_FLASH,
  accountId: "test-account", apiToken: "test-token",
};

// A minimal OpenAI-style completion: one content chunk, a stop chunk, then [DONE]. pi
// requires a finish_reason (it throws "Stream ended without finish_reason" otherwise).
const COMPLETION_SSE = [
  'data: {"id":"chatcmpl-turn","object":"chat.completion.chunk","created":1,' +
      '"model":"x","choices":[{"index":0,"delta":{"role":"assistant",' +
      '"content":"done."},"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-turn","object":"chat.completion.chunk","created":1,' +
      '"model":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  "",
  "data: [DONE]",
  "",
].join("\n");

type CapturedRequest = { url: string; body: string };

async function withTurn(
    effort: string | null, prompt: PromptSelection | null,
    fn: (captured: CapturedRequest[]) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`turn-start-${crypto.randomUUID()}`);
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
    // No gatekeeper bindings in the test worker; the real method would log a warning and
    // return [] via its catch path, so return [] directly for quiet output.
    impl.listConnectableVendors = async () => [];
    // The test worker binds no BLUEPRINTS KV; the admin mirror is faked instead.
    impl.env = {
      ...impl.env,
      BLUEPRINTS: {
        get: async () => serializeAdminConfig({
          ...DEFAULT_ADMIN_CONFIG,
          promptPresets: [{id: "preset-1", name: "Reviewer", text: PRESET_TEXT}],
        }),
      },
    };
    let captured: CapturedRequest[] = [];
    let realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      let request = new Request(input, init);
      captured.push({ url: request.url, body: await request.text() });
      return new Response(COMPLETION_SSE, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      let chatId = await impl.newChat(
          userStub, { profile: USER, aiModel: { profile: AGENT, config: CONFIG } },
          "hi", undefined, undefined, undefined, undefined, undefined,
          effort, prompt);
      // The turn runs detached (startAgent returns void); wait for its teardown.
      let deadline = Date.now() + 20000;
      while (impl.storage.activeAgents.get(chatId) !== undefined) {
        if (Date.now() > deadline) {
          throw new Error(
              `turn did not finish; captured ${captured.length} requests`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await fn(captured);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

/** The turn's system content: every system message's content, joined. */
function systemText(body: any): string {
  let systems = (body.messages as any[]).filter(m => m.role === "system");
  expect(systems.length).toBeGreaterThan(0);
  return systems
      .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content))
      .join("\n");
}

describe("turn-start threading", () => {
  it("sends the seeded effort override as reasoning_effort", async () => {
    await withTurn("high", null, async (captured) => {
      expect(captured.length).toBe(1);
      let body = JSON.parse(captured[0].body);
      expect(body.reasoning_effort).toBe("high");
      // ... while the built-in prompt still fills the static slot.
      expect(systemText(body).startsWith(SYSTEM_PROMPT)).toBe(true);
    });
  }, 30000);

  it("resolves the seeded prompt preset into the static slot", async () => {
    await withTurn(null, {kind: "admin", id: "preset-1"}, async (captured) => {
      expect(captured.length).toBe(1);
      let body = JSON.parse(captured[0].body);
      expect("reasoning_effort" in body).toBe(false);
      expect(systemText(body).startsWith(PRESET_TEXT)).toBe(true);
    });
  }, 30000);

  it("sends neither when the chat has no overrides", async () => {
    await withTurn(null, null, async (captured) => {
      expect(captured.length).toBe(1);
      let body = JSON.parse(captured[0].body);
      expect("reasoning_effort" in body).toBe(false);
      expect(systemText(body).startsWith(SYSTEM_PROMPT)).toBe(true);
    });
  }, 30000);
});
