// A connect link the Workshop bound to a person must not complete for anyone else (fork).
// The Worker has no CF_ACCESS_AUD here, so `accessEmailReader` is absent and every browser reads
// as "no verifiable identity" -- which a bound link must refuse and an unbound link must not
// notice. That is the fail-closed half; the identity-matching half is covered by
// `packages/mcp-shared/__tests__/fork/connect-initiator.test.ts`.
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WRONG_ACCOUNT_HTML } from "@gadgets/backend-utils/fork/connect-initiator";
import type { UserAccount } from "../../src/github.js";

// The connect-link route returns NOT_CONFIGURED_HTML before reaching the guard unless these are
// set -- vitest.worker.config.ts does not bind them (unlike gatekeeper-linear's), so they're set
// directly on `env` here rather than editing the upstream-owned config file.
const mutable = env as unknown as { CLIENT_ID?: string; CLIENT_SECRET?: string };
mutable.CLIENT_ID = "test-client-id";
mutable.CLIENT_SECRET = "test-client-secret";

const BASE = "http://localhost:8787/gatekeeper/github";
const NONCE = "b".repeat(64);

function accounts(): DurableObjectNamespace<UserAccount> {
  return (env as { USER_ACCOUNT: DurableObjectNamespace<UserAccount> }).USER_ACCOUNT;
}

/**
 * A connect callback that must never be invoked by these tests. `setCallback` persists it to real
 * Durable Object storage (`ctx.storage.kv.put("callback", callback)`), which workerd only
 * serializes for a "persistent" stub it can reconstruct later -- a Durable Object stub addressed
 * by (namespace, id) qualifies, but only when it is reached through the *storing worker's own*
 * bindings. A stub built from the outer test's `env.USER_ACCOUNT` (a proxy binding belonging to
 * the vitest-pool-workers runner script, not the worker under test) is refused: "the target worker
 * does not have the allow_irrevocable_stub_storage compatibility flag enabled". Reaching the
 * namespace through the account's own `ctx.exports` instead -- exactly how `GatekeeperVendor`
 * obtains a `UserAccount` stub in production (`ctx.exports.UserAccount.get(...)`) -- satisfies it.
 * `ctx` is TypeScript-`protected` only, not runtime-private, so the cast below is safe. None of
 * these tests ever reach a code path that calls the callback.
 */
function callback(account: UserAccount): never {
  const exports = (account as unknown as {
    ctx: { exports: { UserAccount: DurableObjectNamespace<UserAccount> } };
  }).ctx.exports;
  return exports.UserAccount.get(exports.UserAccount.newUniqueId()) as never;
}

async function armed(initiator?: { email: string }): Promise<string> {
  const ns = accounts();
  const id = ns.newUniqueId();
  await runInDurableObject(ns.get(id), async (account: UserAccount) => {
    await account.setCallback(callback(account), NONCE, ["repo"], false, initiator);
  });
  return id.toString();
}

describe("connect link", () => {
  it("refuses a bound link when the browser carries no verified identity", async () => {
    const id = await armed({ email: "adam@example.com" });
    const ctx = createExecutionContext();
    const response = await (await import("../../src/github.js")).default
      .fetch(new Request(`${BASE}/${id}/${NONCE}`), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe(WRONG_ACCOUNT_HTML);
    // Refused before the nonce was spent, so the rightful owner's link still works.
    await runInDurableObject(accounts().get(accounts().idFromString(id)), async (account: UserAccount) => {
      expect(await account.initiatorMatches("adam@example.com")).toBe(true);
    });
  });

  it("still redirects an unbound link", async () => {
    const id = await armed();
    const ctx = createExecutionContext();
    const response = await (await import("../../src/github.js")).default
      .fetch(new Request(`${BASE}/${id}/${NONCE}`), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("github.com/login/oauth/authorize");
  });
});

describe("oauth callback", () => {
  it("refuses a bound callback before the code is exchanged", async () => {
    const id = await armed({ email: "adam@example.com" });
    const oauthNonce = await runInDurableObject(
      accounts().get(accounts().idFromString(id)),
      async (account: UserAccount) => (await account.beginOAuthFlow(NONCE))?.oauthNonce);
    expect(oauthNonce).toBeTruthy();

    const ctx = createExecutionContext();
    const state = encodeURIComponent(`${id}:${oauthNonce}`);
    const response = await (await import("../../src/github.js")).default
      .fetch(new Request(`${BASE}/oauth?state=${state}&code=test-code`), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
    // The initiator survived the hand-off to the OAuth stage, which is what makes the check work
    // on the callback at all.
    await runInDurableObject(accounts().get(accounts().idFromString(id)), async (account: UserAccount) => {
      expect(await account.initiatorMatches("adam@example.com")).toBe(true);
    });
  });
});
