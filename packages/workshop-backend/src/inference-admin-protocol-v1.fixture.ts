import type {
  AiExecutorProfile,
  AiExecutorProfileInput,
} from "@gadgets/workshop-shared/api";
import type { WorkerEntrypoint } from "cloudflare:workers";
import type { InferenceAdmin } from "./admin-settings.js";

type Equal<Left, Right> = (
  <Value>() => Value extends Left ? 1 : 2
) extends (<Value>() => Value extends Right ? 1 : 2) ? true : false;

function assertExactShape<Check extends true>(..._check: Check extends true ? [] : never): void {}

type PrivateInferenceAdminSurface = Omit<InferenceAdmin, keyof WorkerEntrypoint>;

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

type V1InferenceAdmin = {
  readonly protocolVersion: 1;
  listProfiles(): Promise<V1Profile[]>;
  createProfile(input: V1ProfileInput): Promise<V1Profile>;
  updateProfile(id: string, input: V1ProfileInput, revision: number): Promise<V1Profile>;
  verifyProfile(id: string, revision: number): Promise<V1Profile>;
  activateProfile(id: string, revision: number): Promise<V1Profile>;
  disableProfile(id: string, revision: number): Promise<V1Profile>;
};

assertExactShape<Equal<PrivateInferenceAdminSurface, V1InferenceAdmin>>();
assertExactShape<Equal<AiExecutorProfileInput, V1ProfileInput>>();
assertExactShape<Equal<AiExecutorProfile, V1Profile>>();

const bedrockInput = {
  provider: "aws-bedrock",
  label: "Protocol parity",
  maxInputBytes: 1024,
  maxOutputTokens: 256,
  timeoutMs: 5_000,
  requestsPerMinute: 10,
  model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
} satisfies Extract<V1ProfileInput, { provider: "aws-bedrock" }>;

const profileResult = {
  ...bedrockInput,
  id: "profile-v1",
  lifecycle: "active",
  revision: 1,
} satisfies V1Profile;

const privateInferenceAdminFixture: V1InferenceAdmin = {
  protocolVersion: 1,
  listProfiles: async () => [profileResult],
  createProfile: async (_input) => profileResult,
  updateProfile: async (_id, _input, _revision) => profileResult,
  verifyProfile: async (_id, _revision) => profileResult,
  activateProfile: async (_id, _revision) => profileResult,
  disableProfile: async (_id, _revision) => profileResult,
};

void privateInferenceAdminFixture;
