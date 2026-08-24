import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  BoundarySession,
  FakeInferenceRuntime,
  TestHooks,
} from "../worker.js";

const testEnv = env as unknown as {
  TEST_HOOKS: DurableObjectNamespace<TestHooks>;
  RUNTIME_CONTROL: Fetcher<FakeInferenceRuntime>;
};

beforeEach(async () => {
  await reset();
  await testEnv.RUNTIME_CONTROL.reset();
});

describe("AI executor real Worker RPC boundary", () => {
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
      profileId: "profile-workerd",
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
      observations: [{ prohibitAllSharing: true }],
    });

  });
});
