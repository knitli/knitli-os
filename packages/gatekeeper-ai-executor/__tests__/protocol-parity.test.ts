import type {
  AdminApi,
  AiExecutorProfile,
  AiExecutorProfileInput,
} from "@gadgets/workshop-shared/api";
import {
  MAX_ACTIVE_EXECUTOR_PROFILES,
  MAX_EXECUTOR_PROFILE_LABEL_BYTES,
  MAX_EXECUTOR_PROFILE_MODEL_BYTES,
  MAX_EXECUTOR_PROFILE_PROVIDER_CONFIG_BYTES,
  MAX_STORED_EXECUTOR_PROFILES,
} from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import type { ActiveExecutorProfile, InferenceRuntime } from "../src/protocol.js";
import { AI_EXECUTOR_PROTOCOL_VERSION } from "../src/protocol.js";

type Equal<Left, Right> = (
  <Value>() => Value extends Left ? 1 : 2
) extends (<Value>() => Value extends Right ? 1 : 2) ? true : false;

function assertExactShape<Check extends true>(..._check: Check extends true ? [] : never): void {}

type WorkshopAiExecutorMethods =
  | "listAiExecutorProfiles"
  | "createAiExecutorProfile"
  | "updateAiExecutorProfile"
  | "verifyAiExecutorProfile"
  | "activateAiExecutorProfile"
  | "disableAiExecutorProfile";

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

assertExactShape<Equal<Extract<keyof AdminApi, `${string}AiExecutor${string}`>, WorkshopAiExecutorMethods>>();
assertExactShape<Equal<InferenceRuntime, V1InferenceRuntime>>();
assertExactShape<Equal<Pick<AdminApi, WorkshopAiExecutorMethods>, V1WorkshopAdmin>>();
assertExactShape<Equal<AiExecutorProfileInput, V1ProfileInput>>();
assertExactShape<Equal<AiExecutorProfile, V1Profile>>();
assertExactShape<Equal<ActiveExecutorProfile, V1ActiveProfile>>();

describe("AI executor v1 protocol parity", () => {
  it("pins the independent Gatekeeper runtime and Workshop admin shapes", () => {
    expect(AI_EXECUTOR_PROTOCOL_VERSION).toBe(1);
    expect(MAX_ACTIVE_EXECUTOR_PROFILES).toBe(100);
    expect(MAX_STORED_EXECUTOR_PROFILES).toBe(100);
    expect(MAX_EXECUTOR_PROFILE_LABEL_BYTES).toBe(100);
    expect(MAX_EXECUTOR_PROFILE_MODEL_BYTES).toBe(256);
    expect(MAX_EXECUTOR_PROFILE_PROVIDER_CONFIG_BYTES).toBe(256);
  });
});
