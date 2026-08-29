import { MAX_ACTIVE_EXECUTOR_PROFILES } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import {
  AI_EXECUTOR_PROTOCOL_VERSION,
  type InferenceRuntime,
} from "../src/protocol.js";
import {
  canonicalProfileUrl,
  parseActiveProfiles,
  parseProfileResourceUrl,
  supportedResourceForProfile,
} from "../src/resources.js";

const PROFILE_ID = "0198ddb0-7ac5-7ee9-8e65-62da80270035";
const PROFILE = {
  id: PROFILE_ID,
  label: "Reasoner",
  provider: "openrouter" as const,
  model: "openai/gpt-5",
  revision: 7,
};

function runtime(
  profiles: unknown,
  protocolVersion: unknown = AI_EXECUTOR_PROTOCOL_VERSION,
): InferenceRuntime {
  return {
    protocolVersion,
    listActiveProfiles: async () => profiles,
    invoke: async () => ({ text: "", finishReason: "stop" }),
  } as InferenceRuntime;
}

describe("AI executor profile resources", () => {
  it("builds and parses the sole canonical lowercase UUID URL", () => {
    const url = `https://ai-executor.invalid/profiles/${PROFILE_ID}`;
    expect(canonicalProfileUrl(PROFILE_ID)).toBe(url);
    expect(parseProfileResourceUrl(url)).toBe(PROFILE_ID);

    for (const malformed of [
      `http://ai-executor.invalid/profiles/${PROFILE_ID}`,
      `https://user@ai-executor.invalid/profiles/${PROFILE_ID}`,
      `https://ai-executor.invalid:443/profiles/${PROFILE_ID}`,
      `https://ai-executor.invalid/profiles/${PROFILE_ID}?x=1`,
      `https://ai-executor.invalid/profiles/${PROFILE_ID}#x`,
      `https://ai-executor.invalid/profiles/${PROFILE_ID}/extra`,
      `https://AI-EXECUTOR.INVALID/profiles/${PROFILE_ID}`,
      `https://ai-executor.invalid/profiles/${PROFILE_ID.toUpperCase()}`,
      "https://ai-executor.invalid/profiles/not-a-uuid",
    ]) {
      expect(() => parseProfileResourceUrl(malformed), malformed).toThrow(
        "Invalid AI executor profile URL",
      );
    }
  });

  it("validates, bounds, and de-duplicates active runtime summaries", async () => {
    await expect(
      parseActiveProfiles(runtime([PROFILE, PROFILE])),
    ).resolves.toEqual([PROFILE]);
    await expect(
      parseActiveProfiles(
        runtime(
          Array.from(
            { length: MAX_ACTIVE_EXECUTOR_PROFILES + 1 },
            () => PROFILE,
          ),
        ),
      ),
    ).rejects.toThrow("Invalid active AI executor profiles");
    await expect(
      parseActiveProfiles(
        runtime([PROFILE, { ...PROFILE, label: "Conflicting duplicate" }]),
      ),
    ).rejects.toThrow("Invalid active AI executor profiles");
    await expect(
      parseActiveProfiles(
        runtime([
          {
            ...PROFILE,
            provider: "arbitrary-provider",
          },
        ]),
      ),
    ).rejects.toThrow("Invalid active AI executor profiles");
    await expect(
      parseActiveProfiles(
        runtime([
          {
            ...PROFILE,
            label: "control\u0000label",
          },
        ]),
      ),
    ).rejects.toThrow("Invalid active AI executor profiles");
    await expect(
      parseActiveProfiles(
        runtime([
          {
            ...PROFILE,
            adminToken: "must-not-cross",
          },
        ]),
      ),
    ).rejects.toThrow("Invalid active AI executor profiles");
    await expect(parseActiveProfiles(runtime([PROFILE], 2))).rejects.toThrow(
      "protocol version",
    );
  });

  it("exposes only safe label, provider, and model metadata", () => {
    const resource = supportedResourceForProfile(PROFILE);
    expect(resource).toEqual({
      urlPattern: canonicalProfileUrl(PROFILE_ID),
      title: "Reasoner",
      description: "openrouter · openai/gpt-5",
    });
    expect(JSON.stringify(resource)).not.toContain("revision");
  });
});
