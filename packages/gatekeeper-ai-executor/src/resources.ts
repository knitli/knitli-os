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

export const AI_EXECUTOR_RESOURCE_ORIGIN = "https://ai-executor.invalid";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDERS = new Set(["aws-bedrock", "azure-openai", "openrouter"]);
const ENCODER = new TextEncoder();

export function canonicalProfileUrl(profileId: string): string {
  if (!UUID_RE.test(profileId))
    throw new Error("Invalid AI executor profile ID.");
  return `${AI_EXECUTOR_RESOURCE_ORIGIN}/profiles/${profileId}`;
}

export function parseProfileResourceUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split("/");
    const profileId =
      segments.length === 3 && segments[0] === "" && segments[1] === "profiles"
        ? segments[2]
        : undefined;
    if (
      !profileId ||
      !UUID_RE.test(profileId) ||
      value !== canonicalProfileUrl(profileId)
    ) {
      throw new Error();
    }
    return profileId;
  } catch {
    throw new Error("Invalid AI executor profile URL.");
  }
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

export function rejectPrivateObserver(_verifier: unknown): never {
  throw new Error(
    "Knitli AI executor bindings are private and cannot be shared.",
  );
}

function invalidProfiles(): Error {
  return new Error("Invalid active AI executor profiles.");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
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
    ENCODER.encode(value).byteLength > maximumBytes ||
    (!allowUuid && hasControlCharacter(value))
  ) {
    throw invalidProfiles();
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
