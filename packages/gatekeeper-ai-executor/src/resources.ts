import {
  MAX_ACTIVE_EXECUTOR_PROFILES,
  MAX_EXECUTOR_PROFILE_LABEL_BYTES,
  MAX_EXECUTOR_PROFILE_MODEL_BYTES,
} from "@gadgets/workshop-shared/api";
import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import {
  type ActiveExecutorProfile,
  AI_EXECUTOR_PROTOCOL_VERSION,
  type InferenceRuntime,
} from "./protocol.js";
import {
  hasControlCharacter,
  hasExactKeys,
  isPlainRecord,
  utf8Bytes,
} from "./validate.js";

export const AI_EXECUTOR_RESOURCE_ORIGIN = "https://ai-executor.invalid";
const PROFILE_URL_PREFIX = `${AI_EXECUTOR_RESOURCE_ORIGIN}/profiles/`;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDERS = new Set(["aws-bedrock", "azure-openai", "openrouter"]);

export function canonicalProfileUrl(profileId: string): string {
  if (!UUID_RE.test(profileId))
    throw new Error("Invalid AI executor profile ID.");
  return `${PROFILE_URL_PREFIX}${profileId}`;
}

/** Accepts only the exact string canonicalProfileUrl() produces, which is the whole test. */
export function parseProfileResourceUrl(value: string): string {
  const profileId = value.startsWith(PROFILE_URL_PREFIX)
    ? value.slice(PROFILE_URL_PREFIX.length)
    : "";
  if (!UUID_RE.test(profileId)) {
    throw new Error("Invalid AI executor profile URL.");
  }
  return profileId;
}

export async function parseActiveProfiles(
  runtime: InferenceRuntime,
): Promise<ActiveExecutorProfile[]> {
  if ((await runtime.protocolVersion) !== AI_EXECUTOR_PROTOCOL_VERSION) {
    throw new Error("Unsupported AI executor protocol version.");
  }
  const value: unknown = await runtime.listActiveProfiles();
  if (!Array.isArray(value) || value.length > MAX_ACTIVE_EXECUTOR_PROFILES) {
    throw invalidProfiles();
  }

  const byId = new Map<string, ActiveExecutorProfile>();
  for (const raw of value) {
    if (
      !isPlainRecord(raw) ||
      !hasExactKeys(raw, ["id", "label", "provider", "model", "revision"])
    ) {
      throw invalidProfiles();
    }
    const id = safeString(raw.id, 36, true);
    const label = safeString(raw.label, MAX_EXECUTOR_PROFILE_LABEL_BYTES);
    const provider = safeString(raw.provider, 32);
    const model = safeString(raw.model, MAX_EXECUTOR_PROFILE_MODEL_BYTES);
    if (
      !UUID_RE.test(id) ||
      !PROVIDERS.has(provider) ||
      !Number.isSafeInteger(raw.revision) ||
      (raw.revision as number) < 1
    ) {
      throw invalidProfiles();
    }
    const profile: ActiveExecutorProfile = {
      id,
      label,
      provider: provider as ActiveExecutorProfile["provider"],
      model,
      revision: raw.revision as number,
    };
    const prior = byId.get(id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(profile))
      throw invalidProfiles();
    byId.set(id, profile);
  }
  return [...byId.values()];
}

export function supportedResourceForProfile(
  profile: ActiveExecutorProfile,
): SupportedResource {
  return {
    urlPattern: canonicalProfileUrl(profile.id),
    title: profile.label,
    description: `${profile.provider} · ${profile.model}`,
  };
}

export async function requireActiveProfile(
  runtime: InferenceRuntime,
  profileId: string,
): Promise<ActiveExecutorProfile> {
  const profile = (await parseActiveProfiles(runtime)).find(
    (candidate) => candidate.id === profileId,
  );
  if (!profile) throw new Error("AI executor profile is not active.");
  return profile;
}

export async function resolveActiveProfileResource(
  runtime: InferenceRuntime,
  resourceUrl: string,
): Promise<ActiveExecutorProfile> {
  return requireActiveProfile(runtime, parseProfileResourceUrl(resourceUrl));
}

function invalidProfiles(): Error {
  return new Error("Invalid active AI executor profiles.");
}

function safeString(
  value: unknown,
  maximumBytes: number,
  allowUuid = false,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    utf8Bytes(value) > maximumBytes ||
    (!allowUuid && hasControlCharacter(value))
  ) {
    throw invalidProfiles();
  }
  return value;
}
