import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as aiExecutorWorker from "../../src/ai-executor.js";

import type {
  BoundarySession,
  CountingVerifier,
  FakeInferenceRuntime,
  TestHooks,
} from "../worker.js";

const testEnv = env as unknown as {
  TEST_HOOKS: DurableObjectNamespace<TestHooks>;
  RUNTIME_CONTROL: Fetcher<FakeInferenceRuntime>;
  VERIFIER_CONTROL: Fetcher<CountingVerifier>;
};
const PROFILE_ID = "0198ddb0-7ac5-7ee9-8e65-62da80270035";
const PROFILE_URL = `https://ai-executor.invalid/profiles/${PROFILE_ID}`;

beforeEach(async () => {
  await reset();
  await testEnv.RUNTIME_CONTROL.reset();
  await testEnv.VERIFIER_CONTROL.reset();
});

describe("AI executor real Worker RPC boundary", () => {
  it("has no HTTP capability and returns the same 404 for every request", async () => {
    const handler = (
      aiExecutorWorker as unknown as {
        default?: { fetch(request: Request): Response | Promise<Response> };
      }
    ).default;
    expect(handler, "AI executor Worker must retain ES-module format").toBeDefined();
    if (!handler) return;

    const requests = [
      new Request("https://executor.invalid/"),
      new Request("https://executor.invalid/oauth/callback?code=not-consumed", {
        method: "POST",
        body: "ignored",
      }),
      new Request("https://executor.invalid/profiles/not-a-profile", {
        method: "DELETE",
      }),
      new Request("https://executor.invalid/anything", { method: "OPTIONS" }),
    ];

    for (const request of requests) {
      const response = await handler.fetch(request);
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Not Found");
    }
  });

  it("round-trips submit, queue apply, and result authorization", async () => {
    const hooks = testEnv.TEST_HOOKS.getByName("session-boundary");
    const session = await hooks.openSession() as BoundarySession;

    const pending = await session.submit({
      messages: [{ role: "user", content: "workerd private prompt" }],
      maxOutputTokens: 64,
    });
    const result = await session.getResult(pending.runId);

    expect(pending).toEqual({ runId: 1, status: "pending" });
    expect(result).toEqual({
      runId: 1,
      status: "completed",
      result: { text: "workerd answer", finishReason: "stop" },
    });
    expect(await testEnv.RUNTIME_CONTROL.calls()).toEqual([{
      profileId: PROFILE_ID,
      request: {
        messages: [{ role: "user", content: "workerd private prompt" }],
        maxOutputTokens: 64,
      },
    }]);
    expect(await hooks.queueState()).toMatchObject({
      actions: [{
        id: 1,
        description: {
          actionKind: { tag: "ai.infer", label: "Run AI inference" },
          awaitDecision: true,
          autoApprovable: true,
          implementsRevert: false,
        },
      }],
      locked: false,
    });
  });

  it("allows a second private executor run after the first result is read", async () => {
    const hooks = testEnv.TEST_HOOKS.getByName("session-repeated-use");
    const session = (await hooks.openSession()) as BoundarySession;
    const first = await session.submit({
      messages: [{ role: "user", content: "first private prompt" }],
      maxOutputTokens: 64,
    });
    await expect(session.getResult(first.runId)).resolves.toMatchObject({
      runId: 1,
      status: "completed",
    });

    const second = await session.submit({
      messages: [{ role: "user", content: "second private prompt" }],
      maxOutputTokens: 32,
    });
    await expect(session.getResult(second.runId)).resolves.toMatchObject({
      runId: second.runId,
      status: "completed",
    });

    expect(await testEnv.RUNTIME_CONTROL.calls()).toHaveLength(2);
    const queue = await hooks.queueState();
    expect(queue.actions).toHaveLength(2);
    expect(queue.locked).toBe(false);
    expect(queue.observations).toHaveLength(2);
    for (const observation of queue.observations) {
      expect(observation).toHaveProperty("prohibitWorkspaceSharing", true);
      expect(observation).not.toHaveProperty("prohibitAllSharing");
    }
  });

  it("crosses the real vendor account resource facet and session boundary", async () => {
    const hooks = testEnv.TEST_HOOKS.getByName("account-resource-boundary");

    await expect(hooks.vendorDescription()).resolves.toMatchObject({
      displayName: "Knitli AI",
      autoProvisionsAccount: true,
      providesAuth: false,
    });
    await expect(hooks.accountResources()).resolves.toEqual([{
      urlPattern: PROFILE_URL,
      title: "Workerd fake",
      description: "openrouter · fake/model",
    }]);

    const opened = await hooks.openThroughAccount(PROFILE_URL);
    expect(opened.accountDisplayName).toBe("Knitli AI");
    expect(opened.resource).toEqual({
      urlPattern: PROFILE_URL,
      title: "Workerd fake",
      description: "openrouter · fake/model",
    });
    expect(opened.description).toEqual({
      url: PROFILE_URL,
      title: "Workerd fake",
      snippet: "openrouter · fake/model",
      observerPolicy: "owner-only",
      suggestedBindingName: "AI_EXECUTOR",
      tsType: "AiExecutor",
    });

    const session = await hooks.openThroughAccountSession(PROFILE_URL) as unknown as BoundarySession;
    const pending = await session.submit({
      messages: [{ role: "user", content: "boundary" }],
    });
    await expect(session.getResult(pending.runId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("removes disabled resources and rejects stale resource minting", async () => {
    const hooks = testEnv.TEST_HOOKS.getByName("disable-removal");
    await expect(hooks.accountResources()).resolves.toHaveLength(1);

    await testEnv.RUNTIME_CONTROL.setProfiles([]);

    await expect(hooks.accountResources()).resolves.toEqual([]);
    await expect(hooks.resolveActiveResourceOutcome(PROFILE_URL)).resolves.toBe(
      "AI executor profile is not active.",
    );
  });

  it("rejects private observers without consulting verifier and removes idempotently", async () => {
    const hooks = testEnv.TEST_HOOKS.getByName("private-observers");
    await expect(hooks.testPrivateObserverPolicy()).resolves.toEqual({
      rejectionMessage: "Knitli AI executor bindings are private and cannot be shared.",
      verifierCalls: 0,
    });
  });
});
