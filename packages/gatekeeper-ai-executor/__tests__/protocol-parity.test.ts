import { describe, expect, it } from "vitest";
import { AI_EXECUTOR_PROTOCOL_VERSION } from "../src/protocol.js";
import type { ActiveExecutorProfile, InferenceRuntime } from "../src/protocol.js";
import type {
  AdminApi,
  AiExecutorProfile,
  AiExecutorProfileInput,
} from "@gadgets/workshop-shared/api";

type Equal<Left, Right> = (
  <Value>() => Value extends Left ? 1 : 2
) extends (<Value>() => Value extends Right ? 1 : 2) ? true : false;

function assertExactShape<Check extends true>(..._check: Check extends true ? [] : never): void {}

type RuntimeMethods = "protocolVersion" | "listActiveProfiles" | "invoke";
type WorkshopAiExecutorMethods =
  | "listAiExecutorProfiles"
  | "createAiExecutorProfile"
  | "updateAiExecutorProfile"
  | "verifyAiExecutorProfile"
  | "activateAiExecutorProfile"
  | "disableAiExecutorProfile";
type CommonProfileInputFields =
  | "provider"
  | "label"
  | "maxInputBytes"
  | "maxOutputTokens"
  | "timeoutMs"
  | "requestsPerMinute"
  | "model";

type V1Provider = "aws-bedrock" | "azure-openai" | "openrouter";
type V1ProfileLimits = {
  label: string;
  maxInputBytes: number;
  maxOutputTokens: number;
  timeoutMs: number;
  requestsPerMinute: number;
};
type V1ProfileInput = V1ProfileLimits & (
  | { provider: "aws-bedrock"; model: string }
  | { provider: "azure-openai"; byokAlias?: string; resource: string; deployment: string; apiVersion: string; model: string }
  | { provider: "openrouter"; byokAlias?: string; model: string }
);
type V1Profile = V1ProfileInput & {
  id: string;
  lifecycle: "draft" | "verified" | "active" | "disabled";
  revision: number;
  verifiedAt?: string;
  verification?: {
    status: "succeeded" | "provider_rejected" | "provider_unavailable" | "timeout";
    durationMs: number;
    gatewayLogId?: string;
    message?: string;
  };
};
type V1ActiveProfile = {
  id: string;
  label: string;
  provider: V1Provider;
  model: string;
  revision: number;
};
type V1Request = {
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string }>;
  tools?: Array<{ name: string; description?: string; inputSchema: unknown }>;
  responseFormat?: { type: "text" } | { type: "json_schema"; name: string; schema: unknown };
  maxOutputTokens?: number;
};
type V1Completion = {
  text: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "unknown";
  usage?: { inputTokens?: number; outputTokens?: number };
  gatewayLogId?: string;
};
type V1InferenceRuntime = {
  readonly protocolVersion: 1;
  listActiveProfiles(): Promise<V1ActiveProfile[]>;
  invoke(profileId: string, request: V1Request): Promise<V1Completion>;
};
type V1WorkshopAdmin = {
  listAiExecutorProfiles(): Promise<V1Profile[]>;
  createAiExecutorProfile(input: V1ProfileInput): Promise<V1Profile>;
  updateAiExecutorProfile(id: string, input: V1ProfileInput, revision: number): Promise<V1Profile>;
  verifyAiExecutorProfile(id: string, revision: number): Promise<V1Profile>;
  activateAiExecutorProfile(id: string, revision: number): Promise<V1Profile>;
  disableAiExecutorProfile(id: string, revision: number): Promise<V1Profile>;
};

assertExactShape<Equal<keyof InferenceRuntime, RuntimeMethods>>();
assertExactShape<Equal<Extract<keyof AdminApi, `${string}AiExecutor${string}`>, WorkshopAiExecutorMethods>>();
assertExactShape<Equal<InferenceRuntime, V1InferenceRuntime>>();
assertExactShape<Equal<Pick<AdminApi, WorkshopAiExecutorMethods>, V1WorkshopAdmin>>();
assertExactShape<Equal<AiExecutorProfileInput, V1ProfileInput>>();
assertExactShape<Equal<AiExecutorProfile, V1Profile>>();
assertExactShape<Equal<ActiveExecutorProfile, V1ActiveProfile>>();
assertExactShape<Equal<keyof Extract<AiExecutorProfileInput, { provider: "aws-bedrock" }>, CommonProfileInputFields>>();
assertExactShape<Equal<keyof Extract<AiExecutorProfileInput, { provider: "azure-openai" }>, CommonProfileInputFields | "resource" | "deployment" | "apiVersion" | "byokAlias">>();
assertExactShape<Equal<keyof Extract<AiExecutorProfileInput, { provider: "openrouter" }>, CommonProfileInputFields | "byokAlias">>();
assertExactShape<Equal<keyof ActiveExecutorProfile, "id" | "label" | "provider" | "model" | "revision">>();

const bedrockInput = {
  provider: "aws-bedrock",
  label: "Protocol parity",
  maxInputBytes: 1024,
  maxOutputTokens: 256,
  timeoutMs: 5_000,
  requestsPerMinute: 10,
  model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
} satisfies Extract<V1ProfileInput, { provider: "aws-bedrock" }>;

const profile = {
  ...bedrockInput,
  id: "profile-v1",
  lifecycle: "active",
  revision: 1,
} satisfies V1Profile;

const activeProfile = {
  id: profile.id,
  label: profile.label,
  provider: profile.provider,
  model: profile.model,
  revision: profile.revision,
} satisfies V1ActiveProfile;

const completion = {
  text: "ok",
  finishReason: "stop",
} satisfies V1Completion;

const runtimeFixture = {
  protocolVersion: AI_EXECUTOR_PROTOCOL_VERSION,
  listActiveProfiles: async () => [activeProfile],
  invoke: async (_profileId: string, _request: V1Request) => completion,
} satisfies V1InferenceRuntime;

const workshopFixture = {
  listAiExecutorProfiles: async () => [profile],
  createAiExecutorProfile: async (_input: V1ProfileInput) => profile,
  updateAiExecutorProfile: async (_id: string, _input: V1ProfileInput, _revision: number) => profile,
  verifyAiExecutorProfile: async (_id: string, _revision: number) => profile,
  activateAiExecutorProfile: async (_id: string, _revision: number) => profile,
  disableAiExecutorProfile: async (_id: string, _revision: number) => profile,
} satisfies V1WorkshopAdmin;

describe("AI executor v1 protocol parity", () => {
  it("pins the independent Gatekeeper runtime and Workshop admin shapes", () => {
    expect(AI_EXECUTOR_PROTOCOL_VERSION).toBe(1);
    expect(Object.keys(runtimeFixture).toSorted()).toEqual([
      "invoke",
      "listActiveProfiles",
      "protocolVersion",
    ]);
    expect(Object.keys(workshopFixture).toSorted()).toEqual([
      "activateAiExecutorProfile",
      "createAiExecutorProfile",
      "disableAiExecutorProfile",
      "listAiExecutorProfiles",
      "updateAiExecutorProfile",
      "verifyAiExecutorProfile",
    ]);
    expect(Object.keys(bedrockInput).toSorted()).toEqual([
      "label",
      "maxInputBytes",
      "maxOutputTokens",
      "model",
      "provider",
      "requestsPerMinute",
      "timeoutMs",
    ]);
  });
});
