// getGatekeeperFacet wraps the facet stub with abortFacetOnReset, so a reset (the gatekeeper
// Worker deployed new code) aborts the facet instead of leaving it dead. do-retry.test.ts covers
// the wrapper; this pins the wiring. Local aborts reject flagless, so the facet is a fake.

import { expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

it("aborts gatekeeper<id> when a call through getGatekeeperFacet rejects with a reset", async () => {
  await runInDurableObject(env.TEST_OVERSEER.getByName("gatekeeper-facet-reset"),
      async (instance: OverseerDurableObject) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let impl = (instance as unknown as { impl: object }).impl;
    let reset = Object.assign(new Error("Durable Object reset."), { durableObjectReset: true });
    let abort = vi.fn<(name: string, reason: unknown) => void>();
    let facets = { get: () => ({ applyAction: async () => { throw reset; } }), abort };
    // The real method on a view of the real impl whose ctx.facets is the fake.
    let view = Object.create(impl, { ctx: { value: { facets } } }) as
        { getGatekeeperFacet(id: number): { applyAction(): Promise<void> } };

    await expect(view.getGatekeeperFacet(7).applyAction()).rejects.toBe(reset);
    expect(abort).toHaveBeenCalledExactlyOnceWith("gatekeeper7", expect.any(Error));
    vi.restoreAllMocks();
  });
});
