import { describe, expect, it } from "vitest";

import { runRevocationCleanup } from "../src/revocation-cleanup.js";

describe("revocation cleanup", () => {
  it("arms capability invalidation before awaiting remote cleanup", async () => {
    const releaseObservers = Promise.withResolvers<void>();
    const releaseListings = Promise.withResolvers<void>();
    const events: string[] = [];
    const cleanup = runRevocationCleanup({
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

    try {
      expect(events).toEqual(["observers:start", "listings:start", "restart"]);
      releaseObservers.resolve();
      releaseListings.resolve();
      await cleanup;
    } finally {
      releaseObservers.resolve();
      releaseListings.resolve();
      await cleanup.catch(() => undefined);
    }

    expect(events).toEqual([
      "observers:start",
      "listings:start",
      "restart",
      "observers:end",
      "listings:end",
    ]);
  });
});
