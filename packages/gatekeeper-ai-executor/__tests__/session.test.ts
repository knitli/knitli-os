import { RpcStub, RpcTarget } from "capnweb";
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
  #putFailure: ((key: string, value: unknown) => boolean) | undefined;

  failNextPutWhere(predicate: (key: string, value: unknown) => boolean): void {
    this.#putFailure = predicate;
  }

  get<T>(key: string): T | undefined {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  put<T>(key: string, value: T): void {
    if (this.#putFailure?.(key, value)) {
      this.#putFailure = undefined;
      throw new Error("injected durable storage put failure");
    }
    this.values.set(key, structuredClone(value));
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  list<T>(options: {
    prefix: string;
    limit?: number;
    reverse?: boolean;
    startAfter?: string;
  }): Map<string, T> {
    const entries = [...this.values]
      .filter(([key]) => key.startsWith(options.prefix))
      .filter(([key]) => options.startAfter === undefined || key > options.startAfter)
      .toSorted(([left], [right]) => left.localeCompare(right));
    if (options.reverse) entries.reverse();
    return new Map(
      entries
        .slice(0, options.limit)
        .map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }
}

const REQUEST: AiRequest = {
  messages: [{ role: "user", content: "private prompt" }],
  maxOutputTokens: 64,
};

const OUTCOME_UNKNOWN = {
  code: "outcome_unknown",
  retryable: false,
  message: "The inference was interrupted after it started, so its outcome is unknown.",
} as const;

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
  it("disposes its approval-queue stub", async () => {
    class DisposableQueue extends RpcTarget {
      async authorizeObservation(): Promise<void> {}
      async submitAction(): Promise<void> {}
    }
    const queue = new RpcStub(new DisposableQueue());
    const { controller } = harness();
    const session = new AiExecutorSession(controller, queue as never);
    const staged = controller.stage(REQUEST);
    await controller.applyAction(staged.runId);

    session[Symbol.dispose]();

    await expect(session.getResult(staged.runId)).rejects.toThrow();
  });

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

  it("closes an ambiguously acknowledged action without leaving its prompt replayable", async () => {
    let acceptedRunId: number | undefined;
    let runtimeCalls = 0;
    const queue = queueFake({
      submitAction: async (runId: number) => {
        acceptedRunId = runId;
        throw new Error("acknowledgement lost after acceptance");
      },
    });
    const runtime = runtimeFake(async () => {
      runtimeCalls++;
      return { text: "must not run", finishReason: "stop" };
    });
    const { controller, session, store } = harness({ queue, runtime });

    await expect(session.submit(REQUEST)).rejects.toThrow("outcome is unknown");
    expect(acceptedRunId).toBe(1);
    expect(store.getStagedRequest(1)).toBeUndefined();
    expect(store.get(1)).toEqual({ runId: 1, status: "failed", error: OUTCOME_UNKNOWN });
    await expect(controller.applyAction(acceptedRunId!)).rejects.toThrow("outcome is unknown");
    await expect(session.getResult(1)).resolves.toEqual({
      runId: 1,
      status: "failed",
      error: OUTCOME_UNKNOWN,
    });
    expect(runtimeCalls).toBe(0);
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

  it("closes malformed post-dispatch completion as outcome_unknown without replay", async () => {
    let runtimeCalls = 0;
    const runtime = runtimeFake(async () => {
      runtimeCalls++;
      return {
        text: "completion containing private material",
        finishReason: "stop",
        rawProviderBody: "token=secret",
      } as never;
    });
    const { controller, session, store } = harness({ runtime });
    const { runId } = await session.submit(REQUEST);

    await expect(controller.applyAction(runId)).rejects.toThrow("outcome is unknown");
    expect(store.get(runId)).toEqual({
      runId,
      status: "failed",
      error: OUTCOME_UNKNOWN,
    });
    await expect(controller.applyAction(runId)).rejects.toThrow("outcome is unknown");
    expect(runtimeCalls).toBe(1);
    expect(JSON.stringify(store.get(runId))).not.toMatch(/private material|secret|rawProviderBody/);
  });

  it("closes oversized post-dispatch completion as outcome_unknown without replay", async () => {
    let runtimeCalls = 0;
    const runtime = runtimeFake(async () => {
      runtimeCalls++;
      return { text: "x".repeat(1024 * 1024 + 1), finishReason: "stop" };
    });
    const { controller, session, store } = harness({ runtime });
    const { runId } = await session.submit(REQUEST);

    await expect(controller.applyAction(runId)).rejects.toThrow("outcome is unknown");

    expect(store.get(runId)).toEqual({ runId, status: "failed", error: OUTCOME_UNKNOWN });
    await expect(controller.applyAction(runId)).rejects.toThrow("outcome is unknown");
    expect(runtimeCalls).toBe(1);
  });

  it("closes a post-dispatch completion write failure without replay", async () => {
    let runtimeCalls = 0;
    const kv = new FakeKv();
    const runtime = runtimeFake(async () => {
      runtimeCalls++;
      kv.failNextPutWhere((_key, value) =>
        typeof value === "object" && value !== null &&
        (value as { status?: unknown }).status === "completed");
      return { text: "private completion", finishReason: "stop" };
    });
    const { controller, session, store } = harness({ kv, runtime });
    const { runId } = await session.submit(REQUEST);

    await expect(controller.applyAction(runId)).rejects.toThrow("outcome is unknown");

    expect(store.get(runId)).toEqual({ runId, status: "failed", error: OUTCOME_UNKNOWN });
    await expect(controller.applyAction(runId)).rejects.toThrow("outcome is unknown");
    expect(runtimeCalls).toBe(1);
    expect(JSON.stringify([...kv.values])).not.toContain("private completion");
  });

  it("rejects a 51st pending/running run before submitting it to the approval queue", async () => {
    let submitted = 0;
    const queue = queueFake({
      submitAction: async () => {
        submitted++;
      },
    });
    const { session, store } = harness({ queue });
    for (let index = 0; index < 50; index++) {
      await session.submit({
        messages: [{ role: "user", content: `private prompt ${index}` }],
      });
    }
    store.claim(1);

    await expect(session.submit(REQUEST)).rejects.toThrow(/50.*awaiting approval/i);

    expect(submitted).toBe(50);
  });

  it("classifies outstanding runs hidden after the first 151 lexical records", async () => {
    const kv = new FakeKv();
    for (let runId = 1000; runId <= 1201; runId++) {
      kv.put(`ai-run:record:${runId}`, {
        runId,
        status: "completed",
        result: { text: `terminal ${runId}`, finishReason: "stop" },
      });
    }
    // These keys sort after every terminal key. The old single-page scan pruned only its first
    // page, then staged new work without ever seeing these 51 outstanding runs.
    for (let runId = 9000; runId <= 9050; runId++) {
      kv.put(`ai-run:record:${runId}`, { runId, status: "pending" });
      kv.put(`ai-run:request:${runId}`, {
        messages: [{ role: "user", content: `hidden private prompt ${runId}` }],
      });
    }
    kv.put("ai-run:next-id", 10_000);
    let submitted = 0;
    const queue = queueFake({
      submitAction: async () => {
        submitted++;
      },
    });
    const { session, store } = harness({ kv, queue });

    await expect(session.submit(REQUEST)).rejects.toThrow(/50.*awaiting approval/i);

    expect(submitted).toBe(0);
    expect(store.get(1000)).toBeUndefined();
    expect(store.get(1102)).toMatchObject({ runId: 1102, status: "completed" });
    expect(store.get(1201)).toMatchObject({ runId: 1201, status: "completed" });
    expect(store.get(9000)).toEqual({ runId: 9000, status: "pending" });
    expect(store.get(10_000)).toBeUndefined();
    expect(store.getStagedRequest(10_000)).toBeUndefined();
  });

  it("fails closed before partially repairing state beyond the finite repair ceiling", () => {
    const kv = new FakeKv();
    for (let runId = 1; runId <= 1001; runId++) {
      kv.put(`ai-run:record:${runId}`, { runId, status: "running" });
      kv.put(`ai-run:request:${runId}`, {
        messages: [{ role: "user", content: `private prompt ${runId}` }],
      });
    }

    expect(() => new AiExecutorRunStore(kv)).toThrow(/repair ceiling.*1000/i);

    expect(kv.get("ai-run:record:1")).toEqual({ runId: 1, status: "running" });
    expect(kv.get("ai-run:record:1001")).toEqual({ runId: 1001, status: "running" });
    expect(kv.get("ai-run:request:1")).toMatchObject({
      messages: [{ content: "private prompt 1" }],
    });
  });

  it.each([
    ["a null record", "ai-run:record:2", null],
    [
      "a mismatched duplicate identity",
      "ai-run:record:2",
      { runId: 1, status: "pending" },
    ],
    [
      "an invalid completed result",
      "ai-run:record:2",
      { runId: 2, status: "completed", result: { text: "unsafe", finishReason: "bogus" } },
    ],
    [
      "a noncanonical failed error",
      "ai-run:record:2",
      {
        runId: 2,
        status: "failed",
        error: {
          code: "provider_unavailable",
          retryable: true,
          message: "raw provider secret",
        },
      },
    ],
  ])("validates the complete snapshot before repairing %s", (_label, invalidKey, invalidValue) => {
    const kv = new FakeKv();
    kv.put("ai-run:record:1", { runId: 1, status: "running" });
    kv.put("ai-run:request:1", {
      messages: [{ role: "user", content: "private prompt must remain" }],
    });
    kv.put(invalidKey, invalidValue);
    const before = structuredClone([...kv.values]);
    const construct = () => new AiExecutorRunStore(kv);

    let thrown: unknown;
    try {
      construct();
    } catch (error) {
      thrown = error;
    }

    expect.soft(thrown).toBeInstanceOf(Error);
    expect.soft(thrown).toMatchObject({
      message: expect.stringMatching(/invalid persisted AI inference run/i),
    });
    expect([...kv.values]).toEqual(before);
  });

  it.each([
    ["a missing request", undefined],
    [
      "a provider escape hatch",
      { messages: [{ role: "user", content: "private prompt" }], url: "https://attacker.invalid" },
    ],
    [
      "an oversized message",
      { messages: [{ role: "user", content: "x".repeat(64 * 1024 + 1) }] },
    ],
  ])("validates %s before applying the constructor plan", (_label, invalidRequest) => {
    const kv = new FakeKv();
    kv.put("ai-run:record:1", { runId: 1, status: "running" });
    kv.put("ai-run:request:1", {
      messages: [{ role: "user", content: "private running prompt must remain" }],
    });
    kv.put("ai-run:record:2", { runId: 2, status: "pending" });
    if (invalidRequest !== undefined) {
      kv.put("ai-run:request:2", invalidRequest);
    }
    const before = structuredClone([...kv.values]);
    const construct = () => new AiExecutorRunStore(kv);

    let thrown: unknown;
    try {
      construct();
    } catch (error) {
      thrown = error;
    }

    expect.soft(thrown).toBeInstanceOf(Error);
    expect.soft(thrown).toMatchObject({
      message: expect.stringMatching(/invalid persisted AI inference request/i),
    });
    expect([...kv.values]).toEqual(before);
  });

  it("evicts old terminal records and orphaned staged payloads while retaining the newest 100", async () => {
    const { controller, kv, session, store } = harness();
    for (let index = 0; index < 105; index++) {
      const { runId } = await session.submit({
        messages: [{ role: "user", content: `private prompt ${index}` }],
      });
      await controller.applyAction(runId);
      if (runId === 1) {
        kv.put("ai-run:request:1", {
          messages: [{ role: "user", content: "orphaned private prompt" }],
        });
      }
    }

    expect(store.get(1)).toBeUndefined();
    expect(store.get(5)).toBeUndefined();
    expect(store.getStagedRequest(1)).toBeUndefined();
    expect(store.get(6)).toMatchObject({ runId: 6, status: "completed" });
    expect(store.get(105)).toEqual({
      runId: 105,
      status: "completed",
      result: { text: "answer", finishReason: "stop" },
    });
    expect(JSON.stringify([...kv.values])).not.toMatch(/orphaned private prompt/);
  });

  it("fails closed before staging when the run-id space is exhausted", async () => {
    let submitted = 0;
    const kv = new FakeKv();
    kv.put("ai-run:next-id", Number.MAX_SAFE_INTEGER);
    const queue = queueFake({
      submitAction: async () => {
        submitted++;
      },
    });
    const { session } = harness({ kv, queue });

    await expect(session.submit(REQUEST)).rejects.toThrow(/run id space is exhausted/i);

    expect(submitted).toBe(0);
    expect([...kv.values.keys()].filter(key => key.startsWith("ai-run:request:"))).toEqual([]);
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
