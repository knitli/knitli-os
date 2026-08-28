import { describe, expect, it } from "vitest";
import { AiExecutorProfileConfigurator } from "../src/profile-configurator.js";
import {
  AI_EXECUTOR_PROTOCOL_VERSION,
  type ActiveExecutorProfile,
  type InferenceRuntime,
} from "../src/protocol.js";
import { canonicalProfileUrl, requireActiveProfile } from "../src/resources.js";

const PROFILE: ActiveExecutorProfile = {
  id: "0198ddb0-7ac5-7ee9-8e65-62da80270035",
  label: "Reasoner",
  provider: "azure-openai",
  model: "gpt-5",
  revision: 3,
};

function runtime(profiles: ActiveExecutorProfile[]): InferenceRuntime {
  return {
    protocolVersion: AI_EXECUTOR_PROTOCOL_VERSION,
    listActiveProfiles: async () => profiles,
    invoke: async () => ({ text: "", finishReason: "stop" }),
  };
}

describe("AI executor active resource selection", () => {
  it("re-lists active membership and rejects a disabled profile", async () => {
    const profiles = [PROFILE];
    const activeRuntime = runtime(profiles);
    await expect(
      requireActiveProfile(activeRuntime, PROFILE.id),
    ).resolves.toEqual(PROFILE);
    profiles.length = 0;
    await expect(
      requireActiveProfile(activeRuntime, PROFILE.id),
    ).rejects.toThrow("not active");
  });

  it("configurator exposes only canonical URL and safe display metadata", async () => {
    const configurator = new AiExecutorProfileConfigurator(PROFILE);
    await expect(configurator.listProfiles()).resolves.toEqual([
      {
        value: PROFILE.id,
        title: "Reasoner",
        subtitle: "azure-openai",
        meta: "gpt-5",
      },
    ]);
    await expect(configurator.resourceUrl(PROFILE.id)).resolves.toBe(
      canonicalProfileUrl(PROFILE.id),
    );
    await expect(
      configurator.resourceUrl("0198ddb0-7ac5-7ee9-8e65-62da80270036"),
    ).rejects.toThrow("not active");
    expect(JSON.stringify(await configurator.listProfiles())).not.toMatch(
      /revision|token|secret|resource|deployment/i,
    );
  });
});
