// Fork: two bounds on what a retained capability or a huge file can cost.
//
// 1. A workspace being deleted is paused like one being revoked. Upstream's deleteSelf() fences new
//    opens with a tombstone (beginDeletion) and then awaits cross-DO cleanup before it schedules
//    the restart; a collaborator's capability opened earlier must not reach the world through
//    action approval, action submission or hook binding in that window.
// 2. The agent's grep keeps at most the matches it could show (scanWorkpieceForGrep's maxMatches),
//    so a file of many matching lines is not held whole before the output budget applies.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { MAX_BUFFERED_BLOB_SIZE } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";
import { formatGrep, matchBlob, matchLines, scanWorkpieceForGrep } from "../src/grep.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

describe("a workspace being deleted is fenced like one being revoked", () => {
  it("pauses readiness, observations and action approval from the tombstone on", async () => {
    let stub = env.TEST_OVERSEER.getByName(`knitli-deletion-fence-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerId = "owner-do";
      impl.storage.ownerId.put("owner-do");
      expect(impl.isRevocationPaused()).toBe(false);

      impl.beginDeletion(new Set(["owner-do"]));

      expect(impl.isRevocationPaused()).toBe(true);
      expect(() => impl.assertNoRevocationPending()).toThrow(/access is changing/);
      await expect(impl.assertGatekeeperObserverReadiness(1)).rejects.toThrow(/access is changing/);
      // Approval, manual or automatic, applies a change in the world: it is refused before it
      // reaches the gatekeeper.
      await expect(impl.applyPendingAction(
          { type: "action", gatekeeperId: 1, id: 1, action: 1 }, { type: "user", id: "p", name: "p" },
          false)).rejects.toThrow(/access is changing/);
    });
  });
});

describe("the agent's grep retains only what it could show", () => {
  const overlay = (text: string) => ({
    getOverlayFiles: () => new Map([["big.txt", text]]),
    getRemovedPaths: () => new Set<string>(),
  });
  const scan = (text: string, maxMatches?: number) => scanWorkpieceForGrep(
      { ensureBlobs: async () => new Set<string>() } as never, overlay(text) as never, 1,
      undefined, undefined, /a/, maxMatches);

  it("stops at the cap, says it did, and leaves an unbounded scan as upstream has it", async () => {
    let text = "a\n".repeat(1000);

    let bounded = await scan(text, 10);
    expect(bounded.matches).toHaveLength(10);
    expect(bounded.truncated).toBe(true);
    expect(formatGrep(bounded, 40)).toContain("+ more matches not shown");

    let whole = await scan(text);
    expect(whole.matches).toHaveLength(1000);
    expect(whole).not.toHaveProperty("truncated");
  });

  it("is not truncated when exactly the cap matches", async () => {
    let exact = await scan("a\n".repeat(10), 10);
    expect(exact.matches).toHaveLength(10);
    expect(exact).not.toHaveProperty("truncated");
  });

  it("stops reading a streamed blob once it has enough", () => {
    let pulled = 0;
    let chunk = new TextEncoder().encode("a\n".repeat(1000));
    let reader = {
      size: MAX_BUFFERED_BLOB_SIZE + 1,
      read: () => { throw new Error("a streamed blob is not read whole"); },
      pieces: function* () { for (let i = 0; i < 1000; i++) { pulled++; yield chunk; } },
    };

    let found = matchBlob(reader as never, /a/, "huge.txt", 5);

    expect(found).toHaveLength(5);
    expect(pulled).toBe(1);
    expect(matchLines("a\na\na\n", /a/, 2)).toHaveLength(2);
  });
});
