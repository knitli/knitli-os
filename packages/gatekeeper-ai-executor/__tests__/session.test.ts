import { describe, expect, it } from "vitest";

import {
  AI_EXECUTOR_PROTOCOL_VERSION,
  AiExecutorActionController,
  AiExecutorRunStore,
  AiExecutorSession,
  type AiRequest,
  type InferenceRuntime,
  type RunKv,
} from "../src/session.js";

class FakeKv implements RunKv {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  put<T>(key: string, value: T): void {
    this.values.set(key, structuredClone(value));
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  list<T>(options: { prefix: string }): Map<string, T> {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(options.prefix))
        .map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }
}

const REQUEST: AiRequest = {
  messages: [{ role: "user", content: "private prompt" }],
  maxOutputTokens: 64,
};

function runtimeFake(invoke?: InferenceRuntime["invoke"]): InferenceRuntime {
  return {
    protocolVersion: AI_EXECUTOR_PROTOCOL_VERSION,
    listActiveProfiles: async () => [],
    invoke: invoke ?? (async () => ({ text: "answer", finishReason: "stop" })),
  };
}

function queueFake(overrides: Record<string, unknown> = {}) {
  return {
    submitAction: async () => undefined,
    authorizeObservation: async () => undefined,
    ...overrides,
  };
}

function harness(options: {
  kv?: FakeKv;
  runtime?: InferenceRuntime;
  queue?: ReturnType<typeof queueFake>;
} = {}) {
  const kv = options.kv ?? new FakeKv();
  const store = new AiExecutorRunStore(kv);
  const runtime = options.runtime ?? runtimeFake();
  const controller = new AiExecutorActionController(store, runtime, "profile-7");
  const queue = options.queue ?? queueFake();
  const session = new AiExecutorSession(controller, queue as never);
  return { controller, kv, queue, runtime, session, store };
}

describe("AI executor deferred session", () => {
  it("stages a bounded request, submits safe ai.infer metadata, and does no inference", async () => {
    let runtimeCalls = 0;
    const actions: Array<{ id: number; description: Record<string, unknown> }> = [];
    const runtime = runtimeFake(async () => {
      runtimeCalls++;
      return { text: "answer", finishReason: "stop" };
    });
    const queue = queueFake({
      submitAction: async (id: number, description: Record<string, unknown>) => {
        actions.push({ id, description });
      },
    });
    const { session, store } = harness({ runtime, queue });

    await expect(session.submit(REQUEST)).resolves.toEqual({ runId: 1, status: "pending" });

    expect(runtimeCalls).toBe(0);
    expect(store.get(1)).toEqual({ runId: 1, status: "pending" });
    expect(store.getStagedRequest(1)).toEqual(REQUEST);
    expect(actions).toEqual([{
      id: 1,
      description: {
        title: "Run AI inference",
        description: "Run the bound AI executor profile.",
        actionKind: { tag: "ai.infer", label: "Run AI inference" },
        awaitDecision: true,
        autoApprovable: true,
        implementsRevert: false,
      },
    }]);
    expect(JSON.stringify(actions)).not.toContain("private prompt");
    expect(JSON.stringify(store.get(1))).not.toContain("private prompt");
  });

  it("removes staged state when action submission fails", async () => {
    const queue = queueFake({
      submitAction: async () => {
        throw new Error("approval queue unavailable");
      },
    });
    const { session, store } = harness({ queue });

    await expect(session.submit(REQUEST)).rejects.toThrow("approval queue unavailable");
    expect(store.get(1)).toBeUndefined();
    expect(store.getStagedRequest(1)).toBeUndefined();
  });

  it("claims before inference and applies a run at most once", async () => {
    let runtimeCalls = 0;
    const runtime = runtimeFake(async (_profileId, request) => {
      runtimeCalls++;
      expect(request).toEqual(REQUEST);
      return { text: "answer", finishReason: "stop", gatewayLogId: "log-1" };
    });
    const { controller, session, store } = harness({ runtime });
    const { runId } = await session.submit(REQUEST);

    await controller.applyAction(runId);
    await controller.applyAction(runId);

    expect(runtimeCalls).toBe(1);
    expect(store.getStagedRequest(runId)).toBeUndefined();
    expect(store.get(runId)).toEqual({
      runId,
      status: "completed",
      result: { text: "answer", finishReason: "stop", gatewayLogId: "log-1" },
    });
  });

  it("takes the running claim before an await so concurrent applies invoke once", async () => {
    let runtimeCalls = 0;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const runtime = runtimeFake(async () => {
      runtimeCalls++;
      entered();
      await blocked;
      return { text: "answer", finishReason: "stop" };
    });
    const { controller, session } = harness({ runtime });
    const { runId } = await session.submit(REQUEST);

    const first = controller.applyAction(runId);
    await started;
    await expect(controller.applyAction(runId)).rejects.toThrow("already running");
    expect(runtimeCalls).toBe(1);
    release();
    await first;
    expect(runtimeCalls).toBe(1);
  });

  it("recovers an interrupted running claim as outcome_unknown without replay", async () => {
    const kv = new FakeKv();
    const first = new AiExecutorRunStore(kv);
    const staged = first.stage(REQUEST);
    first.claim(staged.runId);

    let runtimeCalls = 0;
    const recoveredStore = new AiExecutorRunStore(kv);
    const recovered = new AiExecutorActionController(
      recoveredStore,
      runtimeFake(async () => {
        runtimeCalls++;
        return { text: "duplicate", finishReason: "stop" };
      }),
      "profile-7",
    );

    await expect(recovered.applyAction(staged.runId)).rejects.toThrow(/outcome is unknown/i);
    expect(runtimeCalls).toBe(0);
    expect(recoveredStore.getStagedRequest(staged.runId)).toBeUndefined();
    expect(recoveredStore.get(staged.runId)).toEqual({
      runId: staged.runId,
      status: "failed",
      error: {
        code: "outcome_unknown",
        retryable: false,
        message: "The inference was interrupted after it started, so its outcome is unknown.",
      },
    });
  });

  it("rejects a pending run and removes its staged prompt", async () => {
    const { controller, session, store } = harness();
    const { runId } = await session.submit(REQUEST);

    controller.rejectAction(runId);

    expect(store.get(runId)).toEqual({ runId, status: "rejected" });
    expect(store.getStagedRequest(runId)).toBeUndefined();
  });

  it("does not support revert", async () => {
    const { controller } = harness();
    await expect(controller.revertAction(1)).rejects.toThrow("AI inference cannot be reverted");
  });

  it("fails safely for unknown and malformed run identifiers", async () => {
    const { controller, session } = harness();
    await expect(session.getResult(99)).rejects.toThrow("No AI inference run with id 99");
    await expect(session.getResult(1.5)).rejects.toThrow("getResult() requires an integer run id");
    await expect(controller.applyAction(99)).rejects.toThrow("No AI inference run with id 99");
    expect(() => controller.rejectAction(99)).toThrow("No AI inference run with id 99");
  });

  it("awaits observation authorization before returning a completed result", async () => {
    const events: string[] = [];
    let release!: () => void;
    const authorized = new Promise<void>(resolve => {
      release = resolve;
    });
    const queue = queueFake({
      authorizeObservation: async (description: Record<string, unknown>) => {
        events.push(`authorize:${JSON.stringify(description)}`);
        await authorized;
        events.push("authorized");
      },
    });
    const { controller, session } = harness({ queue });
    const { runId } = await session.submit(REQUEST);
    await controller.applyAction(runId);

    let returned = false;
    const result = session.getResult(runId).then(value => {
      returned = true;
      events.push("returned");
      return value;
    });
    await Promise.resolve();

    expect(returned).toBe(false);
    expect(events[0]).toContain("authorize:");
    expect(events[0]).toContain('"prohibitAllSharing":true');
    expect(events[0]).not.toContain("answer");
    release();
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(events.slice(-2)).toEqual(["authorized", "returned"]);
  });

  it("marks completed-result observation as private-only", async () => {
    let observation: Record<string, unknown> | undefined;
    const queue = queueFake({
      authorizeObservation: async (description: Record<string, unknown>) => {
        observation = description;
      },
    });
    const { controller, session } = harness({ queue });
    const { runId } = await session.submit(REQUEST);
    await controller.applyAction(runId);

    await session.getResult(runId);

    expect(observation).toMatchObject({ prohibitAllSharing: true });
  });

  it("retains only a sanitized failure and removes the staged request", async () => {
    const runtime = runtimeFake(async () => {
      throw Object.assign(new Error("raw provider body: private prompt token=secret"), {
        error: {
          code: "provider_rejected",
          retryable: false,
          message: "The provider rejected the inference request.",
        },
      });
    });
    const { controller, session, store } = harness({ runtime });
    const { runId } = await session.submit(REQUEST);

    await expect(controller.applyAction(runId)).rejects.toThrow(
      "The provider rejected the inference request.",
    );
    expect(store.getStagedRequest(runId)).toBeUndefined();
    expect(store.get(runId)).toEqual({
      runId,
      status: "failed",
      error: {
        code: "provider_rejected",
        retryable: false,
        message: "The provider rejected the inference request.",
      },
    });
    expect(JSON.stringify(store.get(runId))).not.toMatch(/private prompt|secret|raw provider/);
  });

  it("fails closed on protocol mismatch without invoking the runtime", async () => {
    let runtimeCalls = 0;
    const runtime = {
      protocolVersion: 2,
      listActiveProfiles: async () => [],
      invoke: async () => {
        runtimeCalls++;
        return { text: "wrong protocol", finishReason: "stop" as const };
      },
    } as unknown as InferenceRuntime;
    const { controller, session, store } = harness({ runtime });
    const { runId } = await session.submit(REQUEST);

    await expect(controller.applyAction(runId)).rejects.toThrow("profile is unavailable");
    expect(runtimeCalls).toBe(0);
    expect(store.get(runId)).toEqual({
      runId,
      status: "failed",
      error: {
        code: "profile_unavailable",
        retryable: true,
        message: "The bound AI executor profile is unavailable.",
      },
    });
  });

  it("sanitizes a malformed runtime completion instead of retaining it", async () => {
    const runtime = runtimeFake(async () => ({
      text: "completion containing private material",
      finishReason: "stop",
      rawProviderBody: "token=secret",
    } as never));
    const { controller, session, store } = harness({ runtime });
    const { runId } = await session.submit(REQUEST);

    await expect(controller.applyAction(runId)).rejects.toThrow("provider is unavailable");
    expect(store.get(runId)).toEqual({
      runId,
      status: "failed",
      error: {
        code: "provider_unavailable",
        retryable: true,
        message: "The inference provider is unavailable.",
      },
    });
    expect(JSON.stringify(store.get(runId))).not.toMatch(/private material|secret|rawProviderBody/);
  });

  it("rejects provider escape hatches before staging or queueing", async () => {
    let submitted = 0;
    const queue = queueFake({ submitAction: async () => { submitted++; } });
    const { session, store } = harness({ queue });

    await expect(session.submit({
      ...REQUEST,
      url: "https://attacker.invalid",
    } as never)).rejects.toThrow(/unsupported field.*url/i);
    expect(submitted).toBe(0);
    expect(store.get(1)).toBeUndefined();
  });

  it("rejects oversized message content before staging or queueing", async () => {
    let submitted = 0;
    const queue = queueFake({ submitAction: async () => { submitted++; } });
    const { session, store } = harness({ queue });

    await expect(session.submit({
      messages: [{ role: "user", content: "x".repeat(64 * 1024 + 1) }],
    })).rejects.toThrow(/content exceeds 65536 UTF-8 bytes/i);
    expect(submitted).toBe(0);
    expect(store.get(1)).toBeUndefined();
  });
});
