import { describe, expect, it, vi } from "vitest";

import { PendingActionStore } from "../src/pending-actions";

/** Just enough of the Durable Object KV for the store: get, put, delete and prefix list. */
function fakeKv() {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string) { return values.get(key) as T | undefined; },
    put<T>(key: string, value: T) { values.set(key, value); },
    delete(key: string) { values.delete(key); },
    list<T>({ prefix }: { prefix: string }) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)) as [string, T][]);
    },
  };
}

describe("finished actions", () => {
  it("remember an action that was applied, and never one that never existed", () => {
    const store = new PendingActionStore<{ n: number }>(fakeKv() as never);
    const id = store.submit({ n: 1 });

    store.finish(id, "applied");

    expect(store.get(id)).toBeUndefined();
    expect(store.wasFinished(id)).toBe(true);
    expect(store.wasFinished(999)).toBe(false);
  });

  it("are not pushed out by later completions, however many", () => {
    const store = new PendingActionStore<{ n: number }>(fakeKv() as never);
    const first = store.submit({ n: 0 });
    store.finish(first, "applied");

    for (let i = 0; i < 400; i++) store.finish(store.submit({ n: i }), "applied");

    // An approval whose outcome was lost can be retried long after newer actions finished.
    expect(store.wasFinished(first)).toBe(true);
  });

  it("are forgotten once old enough that no replay can come", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
    try {
      const store = new PendingActionStore<{ n: number }>(fakeKv() as never);
      const old = store.submit({ n: 0 });
      store.finish(old, "applied");

      vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
      store.finish(store.submit({ n: 1 }), "applied");

      expect(store.wasFinished(old)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("replaying a finished action", () => {
  it("answers done for the same outcome and fails for the opposite one", () => {
    const store = new PendingActionStore<{ n: number }>(fakeKv() as never);
    const applied = store.submit({ n: 1 });
    const rejected = store.submit({ n: 2 });
    store.finish(applied, "applied");
    store.finish(rejected, "rejected");

    expect(store.replayAnswersDone(applied, "applied")).toBe(true);
    expect(store.replayAnswersDone(rejected, "rejected")).toBe(true);
    // Success here would claim a mutation that did not happen, or deny one that did.
    expect(() => store.replayAnswersDone(applied, "rejected")).toThrow(/already applied/);
    expect(() => store.replayAnswersDone(rejected, "applied")).toThrow(/already rejected/);
    expect(store.replayAnswersDone(999, "applied")).toBe(false);
  });

  it("accepts either outcome for a record kept before outcomes were", () => {
    const kv = fakeKv();
    kv.put("finished:action:5", Date.now());
    const store = new PendingActionStore<{ n: number }>(kv as never);

    expect(store.replayAnswersDone(5, "applied")).toBe(true);
    expect(store.replayAnswersDone(5, "rejected")).toBe(true);
  });
});
