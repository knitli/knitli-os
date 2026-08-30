import { describe, expect, it } from "vitest";

import { runRevocationCleanup } from "../src/revocation-cleanup.js";

describe("revocation cleanup", () => {
  it("arms capability invalidation without waiting for remote cleanup", () => {
    const releaseObservers = Promise.withResolvers<void>();
    const releaseListings = Promise.withResolvers<void>();
    const events: string[] = [];

    runRevocationCleanup({
      tearDownObservers: async () => {
        events.push("observers:start");
        await releaseObservers.promise;
        events.push("observers:end");
      },
      refreshListings: async () => {
        events.push("listings:start");
        await releaseListings.promise;
        events.push("listings:end");
      },
      scheduleRestart: () => events.push("restart"),
    });

    // Both calls are dispatched, then the gate is armed -- and control is back here with neither
    // remote operation finished. Awaiting one would deadlock behind the gate it just closed.
    expect(events).toEqual(["observers:start", "listings:start", "restart"]);

    releaseObservers.resolve();
    releaseListings.resolve();
  });

  it("swallows a cleanup failure rather than failing the revocation", async () => {
    const events: string[] = [];

    runRevocationCleanup({
      tearDownObservers: () => Promise.reject(new Error("gatekeeper DO unreachable")),
      refreshListings: () => Promise.reject(new Error("user DO unreachable")),
      scheduleRestart: () => events.push("restart"),
    });

    expect(events).toEqual(["restart"]);
    // Both rejections are handled inside; an escaping one would take the Durable Object down, and
    // vitest fails the run on it.
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
