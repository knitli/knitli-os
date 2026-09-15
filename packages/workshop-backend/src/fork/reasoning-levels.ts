// Fork-owned reasoning-effort policy: which effort levels each model offers, and which one
// the chat UI presents as the default.
//
// The app's model catalog (SUGGESTED_MODELS plus stored custom models) carries no reasoning
// data, so this module resolves pi-ai's per-model `thinkingLevelMap`s -- corrected where pi's
// data is missing or wrong -- into the level ranges the UI offers and the turns send. If a
// gateway-side model-metadata source ever appears, only this module changes.
//
// Two consumers: makeHandle() (ai-models.ts) attaches the merged map onto every constructed
// model descriptor, and AuthenticatedApi.getModelReasoning() (user.ts) answers the UI's
// per-model level query. pi-ai stays out of the frontend bundle: the RPC speaks plain strings.

import type {
  Api, Model, ThinkingLevel, ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";

/** pi's ThinkingLevel vocabulary in UI order (see pi-ai's `ThinkingLevel`). */
export const THINKING_LEVEL_ORDER: readonly ThinkingLevel[] =
    ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * pi API implementations that consume `options.reasoningEffort` (pi-ai 0.84.4:
 * openai-completions and openai-responses map it through `model.thinkingLevelMap`;
 * anthropic-messages and google-generative-ai ignore it). Levels are offered only for models
 * on these APIs -- offering them elsewhere would be UI that does nothing.
 */
const REASONING_EFFORT_APIS: ReadonlySet<string> =
    new Set(["openai-completions", "openai-responses"]);

// Per-provider pi modules, as in ai-models.ts (never `providers/all`, which drags ~30 providers
// into the bundle; these four are already imported there, so this adds no bundle cost).
const PI_CATALOGS: Record<string, Record<string, Model<Api>> | undefined> = {
  "anthropic": ANTHROPIC_MODELS as Record<string, Model<Api>>,
  "openai": OPENAI_MODELS as Record<string, Model<Api>>,
  "google": GOOGLE_MODELS as Record<string, Model<Api>>,
  "cloudflare-workers-ai": CLOUDFLARE_WORKERS_AI_MODELS as Record<string, Model<Api>>,
};

// App provider to the pi provider id + API its models are constructed with (see ai-models.ts:
// every construction path agrees per provider, so this table is exact, not heuristic).
const APP_PROVIDER_PI_SHAPE: Record<AiModelConfig["provider"], {pi: string, api: string}> = {
  "anthropic": {pi: "anthropic", api: "anthropic-messages"},
  "openai": {pi: "openai", api: "openai-responses"},
  "google": {pi: "google", api: "google-generative-ai"},
  "cloudflare": {pi: "cloudflare-workers-ai", api: "openai-completions"},
  // Ollama has no pi catalog; its models resolve through fork overrides only.
  "ollama": {pi: "ollama", api: "openai-completions"},
};

/**
 * Fork corrections to pi's thinking-level data, keyed by `${piProvider} ${modelId}`. An entry
 * merges over pi's map (or stands alone when pi has none). Correct here immediately when a
 * level proves wrong against a live provider; pi bumps are picked up normally.
 */
const FORK_THINKING_LEVEL_OVERRIDES: Record<string, ThinkingLevelMap> = {
  // pi 0.84.4 has no map for GLM-5.3-Flash while every sibling @cf/zai-org GLM carries the
  // identical low/medium/high one; mirror the family until the provider says otherwise.
  "cloudflare-workers-ai @cf/zai-org/glm-5.3-flash": {
    off: null, minimal: null, low: "low", medium: "medium", high: "high",
    xhigh: null, max: null,
  },
};

/** pi's thinking-level map for a model, or undefined when pi catalogs no map for it. */
export function piCatalogThinkingLevelMap(
    piProvider: string, modelId: string): ThinkingLevelMap | undefined {
  return PI_CATALOGS[piProvider]?.[modelId]?.thinkingLevelMap;
}

/**
 * The effective thinking-level map for a constructed model: the caller's catalog map (or pi's
 * own lookup when the caller has none, which also repairs construction paths that drop it),
 * with fork corrections merged over it. Returns undefined when neither source has a map.
 */
export function resolveThinkingLevelMap(
    piProvider: string, modelId: string,
    catalogMap: ThinkingLevelMap | undefined): ThinkingLevelMap | undefined {
  let base = catalogMap ?? piCatalogThinkingLevelMap(piProvider, modelId);
  let override = FORK_THINKING_LEVEL_OVERRIDES[`${piProvider} ${modelId}`];
  if (!override) return base;
  return {...base, ...override};
}

/**
 * The levels a thinking-level map offers the UI, in canonical order: every ThinkingLevel with
 * a provider value. `off` is not a ThinkingLevel, and a null entry means "no known provider
 * value" -- offering it would send a level the map author deliberately withheld (pi's impls
 * either omit nulls or pass the raw name through, depending on branch).
 */
export function reasoningLevelsForMap(
    map: ThinkingLevelMap | undefined): ThinkingLevel[] {
  if (!map) return [];
  return THINKING_LEVEL_ORDER.filter(level => typeof map[level] === "string");
}

/**
 * The level the UI presents as the default for a range: medium when offered, else the lower
 * middle of the range (the cheaper half -- e.g. high of [high, max]), else medium as the
 * conservative fallback. Display only: a chat with no stored effort override runs the provider
 * default (nothing is sent), exactly as before.
 */
export function defaultReasoningEffort(levels: readonly ThinkingLevel[]): ThinkingLevel {
  if (levels.includes("medium")) return "medium";
  if (levels.length > 0) return levels[Math.floor((levels.length - 1) / 2)];
  return "medium";
}

/** Whether a value is one of pi's six reasoning-effort level names. */
export function isReasoningLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" &&
      (THINKING_LEVEL_ORDER as readonly string[]).includes(value);
}

/**
 * The reasoning control for an app model config, or null when the model offers none: its API
 * ignores reasoning effort, or its merged map yields no levels. Backs
 * AuthenticatedApi.getModelReasoning(); pure and key-free, so it is safe to expose over RPC.
 */
export function modelReasoningForConfig(
    provider: AiModelConfig["provider"], modelId: string)
    : {levels: ThinkingLevel[], default: ThinkingLevel} | null {
  let shape = APP_PROVIDER_PI_SHAPE[provider];
  if (!REASONING_EFFORT_APIS.has(shape.api)) return null;
  let levels = reasoningLevelsForMap(
      resolveThinkingLevelMap(shape.pi, modelId, undefined));
  if (levels.length === 0) return null;
  return {levels, default: defaultReasoningEffort(levels)};
}
