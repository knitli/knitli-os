import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";
import { AiGatewayConfig } from "../src/ai-gateway.js";
import { getModel, type ModelHandle } from "../src/ai-models.js";
import {
  defaultReasoningEffort, isReasoningLevel, modelReasoningForConfig,
  reasoningLevelsForMap, resolveThinkingLevelMap,
} from "../src/fork/reasoning-levels.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// Slice 0 (reasoning data foundation) pins: the fork resolver's merge precedence, the
// per-model level ranges the UI will offer, the getModelReasoning RPC resolution, the
// makeHandle wiring (including the Workers AI descriptors that never carried a map), and --
// via request capture -- that attaching maps changes nothing until an effort is passed.

const INITIATOR: AiChatAuthorInfo = { type: "user", id: "user-1", name: "User" };

const GLM_FLASH = "@cf/zai-org/glm-5.3-flash";
const DEEPSEEK_PRO = "@cf/deepseek-ai/deepseek-v4-pro-0813";
const KIMI_CODE = "@cf/moonshotai/kimi-k2.7-code";

function gatewayEnv(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
    CF_AI_GATEWAY_API_TOKEN: "gateway-token",
    CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google,cloudflare",
    ...overrides,
  } as Cloudflare.Env;
}

function directEnv(): Cloudflare.Env {
  return { CF_AI_GATEWAY_PROVIDERS: "" } as Cloudflare.Env;
}

describe("resolveThinkingLevelMap", () => {
  it("returns pi's map for GLM-5.3-Flash now that pi catalogs one", () => {
    // pi 0.84.4 cataloged no map, so the fork override table mirrored the family's
    // {low, medium, high}; pi 0.87.1 ships {low, high, max} and the override is gone.
    expect(resolveThinkingLevelMap("cloudflare-workers-ai", GLM_FLASH, undefined)).toEqual({
      off: null, minimal: null, low: "low", medium: null, high: "high",
      xhigh: null, max: "max",
    });
  });

  it("prefers a passed catalog map over pi's own lookup", () => {
    let catalog = { low: "low", medium: "CUSTOM", high: "high" };
    expect(resolveThinkingLevelMap(
        "cloudflare-workers-ai", GLM_FLASH, catalog)).toEqual(catalog);
  });

  it("passes pi's map through untouched when no override exists", () => {
    let catalog = { minimal: null, low: null, medium: null, high: "high", max: "max" };
    expect(resolveThinkingLevelMap(
        "cloudflare-workers-ai", DEEPSEEK_PRO, catalog)).toEqual(catalog);
  });

  it("falls back to pi's own lookup when the caller has no catalog map", () => {
    // The Workers AI construction paths drop the map; the resolver repairs that.
    expect(resolveThinkingLevelMap(
        "cloudflare-workers-ai", DEEPSEEK_PRO, undefined)).toEqual({
      minimal: null, low: null, medium: null, high: "high", max: "max",
    });
  });

  it("returns undefined for models neither source knows", () => {
    expect(resolveThinkingLevelMap(
        "cloudflare-workers-ai", "@cf/unknown/model", undefined)).toBeUndefined();
    expect(resolveThinkingLevelMap("ollama", "muse-glimmer", undefined)).toBeUndefined();
  });
});

describe("reasoningLevelsForMap", () => {
  it("offers DeepSeek's high/max range", () => {
    expect(reasoningLevelsForMap(
        resolveThinkingLevelMap("cloudflare-workers-ai", DEEPSEEK_PRO, undefined)))
        .toEqual(["high", "max"]);
  });

  it("orders levels canonically and drops off/null entries", () => {
    expect(reasoningLevelsForMap({
      max: "max", off: "none", minimal: null, low: "low", medium: "medium",
      high: "high", xhigh: "xhigh",
    })).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("yields no levels for off-only maps and missing maps", () => {
    expect(reasoningLevelsForMap({ off: null })).toEqual([]);
    expect(reasoningLevelsForMap(undefined)).toEqual([]);
  });
});

describe("defaultReasoningEffort", () => {
  it("prefers medium, else the lower middle, else medium", () => {
    expect(defaultReasoningEffort(["low", "medium", "high"])).toBe("medium");
    expect(defaultReasoningEffort(["high", "max"])).toBe("high");
    expect(defaultReasoningEffort(["low", "medium", "high", "xhigh"])).toBe("medium");
    expect(defaultReasoningEffort([])).toBe("medium");
  });
});

describe("isReasoningLevel", () => {
  it("accepts exactly pi's six level names", () => {
    for (let level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(isReasoningLevel(level)).toBe(true);
    }
    for (let other of ["off", "ultra", "", "Medium", null, undefined, 42, {}]) {
      expect(isReasoningLevel(other)).toBe(false);
    }
  });
});

describe("modelReasoningForConfig", () => {
  it("resolves the Workers AI picker models", () => {
    // pi 0.87.1 revised the GLM-5.3 family from {low, medium, high} to {low, high, max}.
    expect(modelReasoningForConfig("cloudflare", GLM_FLASH)).toEqual({
      levels: ["low", "high", "max"], default: "high",
    });
    expect(modelReasoningForConfig("cloudflare", DEEPSEEK_PRO)).toEqual({
      levels: ["high", "max"], default: "high",
    });
  });

  it("offers no control where pi catalogs no map", () => {
    // pi 0.87.1 dropped kimi-k2.7-code's map while narrowing its sibling to {high}; the
    // fork takes that at face value (provider default applies) rather than restoring the
    // 0.84.4 range unproven.
    expect(modelReasoningForConfig("cloudflare", KIMI_CODE)).toBeNull();
  });

  it("resolves OpenAI's full range including xhigh/max", () => {
    expect(modelReasoningForConfig("openai", "gpt-5.6-sol")).toEqual({
      levels: ["low", "medium", "high", "xhigh", "max"], default: "medium",
    });
  });

  it("returns null where pi's API impl ignores reasoning effort", () => {
    // Claude Opus *has* a pi map ({xhigh, max}), but anthropic-messages never reads
    // options.reasoningEffort, so no control is offered.
    expect(modelReasoningForConfig("anthropic", "claude-opus-5")).toBeNull();
    expect(modelReasoningForConfig("anthropic", "claude-haiku-4-5")).toBeNull();
    expect(modelReasoningForConfig("google", "gemini-3.6-flash")).toBeNull();
  });

  it("returns null for unknown models", () => {
    expect(modelReasoningForConfig("cloudflare", "@cf/unknown/model")).toBeNull();
    expect(modelReasoningForConfig("ollama", "muse-glimmer")).toBeNull();
  });
});

describe("getModelReasoning resolution", () => {
  it("resolves gateway built-in ids through the fork table", () => {
    let gwConfig = new AiGatewayConfig(gatewayEnv());
    for (let [id, expected] of [
      [GLM_FLASH, { levels: ["low", "high", "max"], default: "high" }],
      [DEEPSEEK_PRO, { levels: ["high", "max"], default: "high" }],
      ["gpt-5.6-terra", {
        levels: ["low", "medium", "high", "xhigh", "max"], default: "medium",
      }],
    ] as const) {
      let record = gwConfig.resolveModel(id);
      expect(record).toBeDefined();
      expect(modelReasoningForConfig(record!.config.provider, record!.config.model))
          .toEqual(expected);
    }
    expect(gwConfig.resolveModel("claude-opus-5")).toBeDefined();
    let claude = gwConfig.resolveModel("claude-opus-5")!;
    expect(modelReasoningForConfig(claude.config.provider, claude.config.model)).toBeNull();
  });

  // The first TEST_USER touch in this file cold-starts the DO (measured ~3.5s solo),
  // so these carry a timeout with headroom for full-suite parallel load; later calls run in ms.
  it("resolves a stored custom model and null for unknown ids", async () => {
    let stub = env.TEST_USER.getByName("reasoning-levels-custom");
    await stub.addModel(
        { type: "agent", id: "custom-gpt", name: "Custom GPT" },
        { provider: "openai", model: "gpt-5.6-terra", apiToken: "secret" });
    expect(await stub.getModelReasoning("custom-gpt")).toEqual({
      levels: ["low", "medium", "high", "xhigh", "max"], default: "medium",
    });
    expect(await stub.getModelReasoning("no-such-model")).toBeNull();
  }, 30000);

  it("returns null for a stored custom on a gated API", async () => {
    let stub = env.TEST_USER.getByName("reasoning-levels-gated");
    await stub.addModel(
        { type: "agent", id: "custom-claude", name: "Custom Claude" },
        { provider: "anthropic", model: "claude-opus-5", apiToken: "secret" });
    expect(await stub.getModelReasoning("custom-claude")).toBeNull();
  }, 30000);
});

describe("makeHandle thinking-level wiring", () => {
  it("attaches pi's map to Workers AI descriptors that drop it", () => {
    let config: AiModelConfig = {
      provider: "cloudflare", model: GLM_FLASH,
      accountId: "account-id", apiToken: "token",
    };
    let handle = getModel(directEnv(), config, INITIATOR);
    expect(handle.model.api).toBe("openai-completions");
    expect(handle.model.thinkingLevelMap).toEqual({
      off: null, minimal: null, low: "low", medium: null, high: "high",
      xhigh: null, max: "max",
    });
  });

  it("leaves catalog-carried maps untouched", () => {
    let handle = getModel(gatewayEnv(), {
      provider: "anthropic", model: "claude-opus-5", apiToken: "",
    }, INITIATOR);
    expect(handle.model.thinkingLevelMap).toEqual({ off: null, xhigh: "xhigh", max: "max" });
  });

  it("attaches no map where neither source has one", () => {
    let handle = getModel(directEnv(), {
      provider: "ollama", model: "muse-glimmer", apiToken: "",
    }, INITIATOR);
    expect(handle.model.thinkingLevelMap).toBeUndefined();
  });
});

describe("effort request capture", () => {
  type CapturedRequest = { url: string; headers: Headers; body: string };
  const capturedRequests: CapturedRequest[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    capturedRequests.push(
        { url: request.url, headers: request.headers, body: await request.text() });
    return Response.json(
        { error: { type: "bad_request", message: "stubbed" } }, { status: 400 });
  }) as typeof fetch;

  async function captureBody(handle: ModelHandle, effort?: string): Promise<any> {
    const stream = await handle.stream(handle.model, {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    }, { fetch: fetchStub, maxRetries: 0, ...(effort ? { reasoningEffort: effort } : {}) });
    const message = await stream.result();
    expect(message.stopReason).toBe("error");
    expect(capturedRequests.length).toBeGreaterThan(0);
    return JSON.parse(capturedRequests[0].body);
  }

  beforeEach(() => {
    capturedRequests.length = 0;
  });

  it("sends no reasoning fields when no effort is passed (legacy behavior)", async () => {
    let handle = getModel(gatewayEnv(), {
      provider: "cloudflare", model: GLM_FLASH, apiToken: "",
    }, INITIATOR);
    // HTTPS gateway transport: the URL pi's detection would disable effort for.
    expect(handle.model.baseUrl).toContain("gateway.ai.cloudflare.com");
    expect(handle.model.thinkingLevelMap).toBeDefined();
    let body = await captureBody(handle);
    expect("reasoning_effort" in body).toBe(false);
  });

  it("maps an explicit effort to the provider value on the gateway transport", async () => {
    let handle = getModel(gatewayEnv(), {
      provider: "cloudflare", model: GLM_FLASH, apiToken: "",
    }, INITIATOR);
    expect((await captureBody(handle, "high")).reasoning_effort).toBe("high");
  });

  it("maps DeepSeek's max level through the deepseek branch", async () => {
    let handle = getModel(gatewayEnv(), {
      provider: "cloudflare", model: DEEPSEEK_PRO, apiToken: "",
    }, INITIATOR);
    let body = await captureBody(handle, "max");
    expect(body.reasoning_effort).toBe("max");
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("maps effort on the direct Workers AI REST path too", async () => {
    let handle = getModel(directEnv(), {
      provider: "cloudflare", model: "@cf/zai-org/glm-5.2",
      accountId: "account-id", apiToken: "token",
    }, INITIATOR);
    expect(handle.model.baseUrl).toContain("api.cloudflare.com");
    expect((await captureBody(handle, "low")).reasoning_effort).toBe("low");
  });
});
