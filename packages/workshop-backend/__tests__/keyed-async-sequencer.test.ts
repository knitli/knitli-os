import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

import type { OverseerDurableObject } from "../src/overseer.js";
import { KeyedAsyncSequencer } from "../src/keyed-async-sequencer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

describe("KeyedAsyncSequencer", () => {
  it("is wired into real Overseer observer admission", async () => {
    const run = vi.spyOn(KeyedAsyncSequencer.prototype, "run");
    try {
      const stub = env.TEST_OVERSEER.getByName(`observer-sequencer-${crypto.randomUUID()}`);
      await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
        const impl = (instance as unknown as { impl: any }).impl;
        await impl.ensureObserver(
          "profile-wiring",
          {} as never,
          "build",
        );
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).toBe("profile-wiring");
    } finally {
      run.mockRestore();
    }
  });

  it("does not enter a second task for the same key until the first finishes", async () => {
    const sequencer = new KeyedAsyncSequencer<string>();
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const events: string[] = [];

    const first = sequencer.run("profile", async () => {
      events.push("first:start");
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push("first:end");
    });
    const second = sequencer.run("profile", async () => {
      events.push("second:start");
    });

    try {
      await firstEntered.promise;
      expect(events).toEqual(["first:start"]);
      releaseFirst.resolve();
      await Promise.all([first, second]);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }

    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not let a rejected task poison the next task for the same key", async () => {
    const sequencer = new KeyedAsyncSequencer<string>();
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const failure = new Error("expected first-task failure");
    const events: string[] = [];

    const first = sequencer.run("profile", async () => {
      events.push("first:start");
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push("first:fail");
      throw failure;
    });
    const second = sequencer.run("profile", async () => {
      events.push("second:start");
      return "second-result";
    });

    try {
      await firstEntered.promise;
      expect(events).toEqual(["first:start"]);
      releaseFirst.resolve();
      await expect(first).rejects.toBe(failure);
      await expect(second).resolves.toBe("second-result");
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }

    expect(events).toEqual(["first:start", "first:fail", "second:start"]);
  });

  it("allows work for different keys to proceed independently", async () => {
    const sequencer = new KeyedAsyncSequencer<string>();
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const otherEntered = Promise.withResolvers<void>();
    const events: string[] = [];

    const first = sequencer.run("profile-a", async () => {
      events.push("a:start");
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push("a:end");
    });
    const other = sequencer.run("profile-b", async () => {
      events.push("b:start");
      otherEntered.resolve();
      events.push("b:end");
    });

    try {
      await firstEntered.promise;
      await otherEntered.promise;
      await other;
      expect(events).toEqual(["a:start", "b:start", "b:end"]);
      releaseFirst.resolve();
      await first;
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, other]);
    }

    expect(events).toEqual(["a:start", "b:start", "b:end", "a:end"]);
  });
});
