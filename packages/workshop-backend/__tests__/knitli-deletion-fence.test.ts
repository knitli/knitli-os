// Fork: a workspace being deleted is paused like one being revoked. Upstream's deleteSelf() fences
// new opens with a tombstone (beginDeletion) and then awaits cross-DO cleanup before it schedules
// the restart; a collaborator's capability opened earlier must not reach the world through action
// approval, action submission or hook binding in that window.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

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
