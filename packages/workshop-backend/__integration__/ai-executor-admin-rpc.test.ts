import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type {
  AdminApi,
  AuthenticatedApi,
  PublicApi,
} from "@gadgets/workshop-shared/api";
import { AdminApiImpl } from "../src/admin-settings.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type CodedError = Error & { code?: unknown };

type Call = { method: string; args: unknown[] };

interface InferenceAdminControl {
  reset(): Promise<void>;
  setProtocolVersion(value: number): Promise<void>;
  setFailure(value: "none" | "conflict" | "service"): Promise<void>;
  getCalls(): Promise<Call[]>;
}

const control = (env as unknown as {
  AI_INFERENCE_ADMIN_CONTROL: Fetcher<InferenceAdminControl>;
}).AI_INFERENCE_ADMIN_CONTROL;

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);
const PROFILE_ID = "0198ddb0-7ac5-7ee9-8e65-62da80270035";
const BEDROCK_INPUT = {
  label: "Bedrock Sonnet",
  provider: "aws-bedrock" as const,
  model: "anthropic.claude-sonnet-4-20250514-v1:0",
  maxInputBytes: 131_072,
  maxOutputTokens: 4_096,
  timeoutMs: 30_000,
  requestsPerMinute: 12,
};
const AZURE_INPUT = {
  label: "Azure GPT",
  provider: "azure-openai" as const,
  resource: "knitli-enclave",
  deployment: "gpt-5",
  apiVersion: "2026-06-01",
  model: "gpt-5",
  byokAlias: "azure-primary",
  maxInputBytes: 98_304,
  maxOutputTokens: 2_048,
  timeoutMs: 20_000,
  requestsPerMinute: 8,
};

let publicApi: RpcStub<PublicApi>;
let adminSession: RpcStub<AuthenticatedApi>;
let userSession: RpcStub<AuthenticatedApi>;
let adminApi: RpcStub<AdminApi>;

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new TypeError("Expected a WebSocket response.");
  response.webSocket.accept();
  return newWebSocketRpcSession<PublicApi>(response.webSocket);
}

async function rejection(value: PromiseLike<unknown>): Promise<CodedError> {
  try {
    await value;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new TypeError("Expected an Error rejection.", { cause: error });
    }
    return error;
  }
  throw new Error("Expected RPC to reject.");
}

async function createAndAuthenticate(username: string): Promise<RpcStub<AuthenticatedApi>> {
  const token = await publicApi.createAccount(username, username, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${username}.`);
  return await publicApi.authenticate(token);
}

beforeAll(async () => {
  publicApi = await connect();
  adminSession = await createAndAuthenticate("aibridgeadmin");
  userSession = await createAndAuthenticate("aibridgeuser");
  const capability = await adminSession.getAdminApi();
  if (capability === null) throw new Error("Expected the configured administrator capability.");
  adminApi = capability;
});

beforeEach(async () => {
  await control.reset();
});

afterAll(() => {
  adminApi?.[Symbol.dispose]();
  userSession?.[Symbol.dispose]();
  adminSession?.[Symbol.dispose]();
  publicApi?.[Symbol.dispose]();
});

describe("Workshop AI executor administrator RPC bridge", () => {
  it("keeps ordinary admin settings available when inference is not bound", async () => {
    const withoutInference = new AdminApiImpl(
      exports.AdminSettings.getByName(""),
      "aibridgeadmin",
      undefined,
    );

    await expect(withoutInference.getSettings()).resolves.toEqual(
      expect.objectContaining({ signupsEnabled: true }),
    );
    for (const call of [
      () => withoutInference.listAiExecutorProfiles(),
      () => withoutInference.createAiExecutorProfile(BEDROCK_INPUT),
      () => withoutInference.updateAiExecutorProfile(PROFILE_ID, BEDROCK_INPUT, 1),
      () => withoutInference.verifyAiExecutorProfile(PROFILE_ID, 1),
      () => withoutInference.activateAiExecutorProfile(PROFILE_ID, 1),
      () => withoutInference.disableAiExecutorProfile(PROFILE_ID, 1),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: "AI_EXECUTOR_ADMIN_FEATURE_UNAVAILABLE",
        message: "AI executor administration is not enabled on this deployment.",
      });
    }
  });

  it("mints the bridge only for admins and list/create return catalog data", async () => {
    expect(await userSession.getAdminApi()).toBeNull();
    expect(await control.getCalls()).toEqual([]);

    expect(await adminApi.listAiExecutorProfiles()).toEqual([
      expect.objectContaining({
        id: PROFILE_ID,
        provider: "aws-bedrock",
        lifecycle: "draft",
        revision: 1,
      }),
    ]);
    expect(await adminApi.createAiExecutorProfile(BEDROCK_INPUT)).toEqual({
      ...BEDROCK_INPUT,
      id: PROFILE_ID,
      lifecycle: "draft",
      revision: 1,
    });
  });

  it("forwards every mutation argument unchanged", async () => {
    await adminApi.createAiExecutorProfile(AZURE_INPUT);
    await adminApi.updateAiExecutorProfile(PROFILE_ID, BEDROCK_INPUT, 7);
    await adminApi.verifyAiExecutorProfile(PROFILE_ID, 8);
    await adminApi.activateAiExecutorProfile(PROFILE_ID, 9);
    await adminApi.disableAiExecutorProfile(PROFILE_ID, 10);

    expect(await control.getCalls()).toEqual([
      { method: "protocolVersion", args: [] },
      { method: "createProfile", args: [AZURE_INPUT] },
      { method: "protocolVersion", args: [] },
      { method: "updateProfile", args: [PROFILE_ID, BEDROCK_INPUT, 7] },
      { method: "protocolVersion", args: [] },
      { method: "verifyProfile", args: [PROFILE_ID, 8] },
      { method: "protocolVersion", args: [] },
      { method: "activateProfile", args: [PROFILE_ID, 9] },
      { method: "protocolVersion", args: [] },
      { method: "disableProfile", args: [PROFILE_ID, 10] },
    ]);
  });

  it("rejects a protocol mismatch before any catalog method", async () => {
    await control.setProtocolVersion(2);
    const error = await rejection(adminApi.listAiExecutorProfiles());

    expect(error).toMatchObject({
      code: "AI_EXECUTOR_ADMIN_PROTOCOL_MISMATCH",
      message: "The AI executor service uses an incompatible protocol version.",
    });
    expect(await control.getCalls()).toEqual([
      { method: "protocolVersion", args: [] },
    ]);
  });

  it("maps expected-revision failures to a stable local conflict", async () => {
    await control.setFailure("conflict");
    const error = await rejection(adminApi.activateAiExecutorProfile(PROFILE_ID, 4));

    expect(error).toMatchObject({
      code: "AI_EXECUTOR_PROFILE_REVISION_CONFLICT",
      message: "The AI executor profile changed. Reload it and try again.",
    });
    expect(JSON.stringify(error)).not.toContain("upstream revision details");
  });

  it("sanitizes every other inference-service failure", async () => {
    await control.setFailure("service");
    const error = await rejection(adminApi.verifyAiExecutorProfile(PROFILE_ID, 3));

    expect(error).toMatchObject({
      code: "AI_EXECUTOR_ADMIN_SERVICE_UNAVAILABLE",
      message: "The AI executor service is temporarily unavailable.",
    });
    const exposed = JSON.stringify({
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
      code: error.code,
    });
    expect(exposed).not.toContain("SENTINEL_PROVIDER_SECRET");
  });
});
