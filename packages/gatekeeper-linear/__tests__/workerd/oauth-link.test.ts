import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Real `DurableObjectNamespace#idFromString` throws for a well-formed 64-hex string that was
// never minted by this namespace (e.g. a different Durable Object class, or another deployment).
// Both OAuth routes below only shape-check the id with a hex regex before calling it, so a
// syntactically valid but foreign id used to reach `idFromString` uncaught and surface as an
// unhandled 500. `userAccountStub()` in `src/linear.ts` now wraps that call in try/catch. This
// runs under the real workerd pool (no fake `ctx.exports`) so the throw is genuine, same pattern
// as `gatekeeper-openapi/__tests__/harness.test.ts`.
const BASE = "http://localhost:8787/gatekeeper/linear";
const FOREIGN_ID = "a".repeat(64);
const NONCE = "b".repeat(64);

describe("connect-link route", () => {
  it("returns 400 instead of an unhandled 500 for a well-formed id from a foreign namespace", async () => {
    const { default: worker } = await import("../../src/linear.js");
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${BASE}/${FOREIGN_ID}/${NONCE}`), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
  });
});

describe("oauth callback route", () => {
  it("returns 400 instead of an unhandled 500 for a well-formed id from a foreign namespace", async () => {
    const { default: worker } = await import("../../src/linear.js");
    const ctx = createExecutionContext();
    const state = `${FOREIGN_ID}:${NONCE}`;
    const response = await worker.fetch(
      new Request(`${BASE}/oauth?state=${encodeURIComponent(state)}&code=test-code`), env, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
  });
});
