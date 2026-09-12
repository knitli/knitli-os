// A connect link the Workshop bound to a person must not complete for anyone else (fork). No
// CF_ACCESS_AUD is set in this harness, so every browser reads as "no verifiable identity" --
// which a bound link must refuse and an unbound link must not notice. The identity-matching half
// is covered by `packages/mcp-shared/__tests__/fork/connect-initiator.test.ts`.
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { WRONG_ACCOUNT_HTML } from "@gadgets/backend-utils/fork/connect-initiator";
import type { CloudflareGatekeeperUser } from "@gadgets/workshop-shared/cloudflare-gatekeeper";
import { GatekeeperUserImpl, type UserAccount } from "../../src/cloudflare.js";
import { ACCOUNT_OBSERVABILITY_RESOURCE } from "../../src/resources.js";

const BASE = "http://localhost:8787/gatekeeper/cloudflare";
const NONCE = "b".repeat(64);

function accounts(): DurableObjectNamespace<UserAccount> {
  return env.USER_ACCOUNT;
}

/**
 * A connect callback that must never be invoked by these tests. `setCallback` persists it to real
 * Durable Object storage (`ctx.storage.kv.put("callback", callback)`), which workerd only
 * serializes for a "persistent" stub it can reconstruct later -- a Durable Object stub addressed
 * by (namespace, id) qualifies, but only when it is reached through the *storing worker's own*
 * bindings. A stub built from the outer test's `env.USER_ACCOUNT` (a proxy binding belonging to the
 * vitest-pool-workers runner script, not the worker under test) is refused. Reaching the namespace
 * through the account's own `ctx.exports` instead -- exactly how `GatekeeperVendor.connectAccount`
 * obtains a `UserAccount` stub in production -- satisfies it. `ctx` is TypeScript-`protected` only,
 * not runtime-private, so the cast below is safe. None of these tests ever reach a code path that
 * calls the callback.
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
    await account.setCallback(callback(account), NONCE, ["aig.read"], false, initiator);
  });
  return id.toString();
}

beforeEach(() => {
  const mutable = env as unknown as { CLIENT_ID?: string; CLIENT_SECRET?: string };
  mutable.CLIENT_ID = "test-client-id";
  mutable.CLIENT_SECRET = "test-client-secret";
});

describe("connect link", () => {
  it("refuses a bound link when the browser carries no verified identity", async () => {
    const id = await armed({ email: "adam@example.com" });
    const ctx = createExecutionContext();
    const response = await (await import("../../src/cloudflare.js")).default
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
    const response = await (await import("../../src/cloudflare.js")).default
      .fetch(new Request(`${BASE}/${id}/${NONCE}`), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("dash.cloudflare.com/oauth2/auth");
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
    const response = await (await import("../../src/cloudflare.js")).default
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

/**
 * Mint a scope-expansion link the way the Workshop does, by calling `ensureResources` on a
 * `GatekeeperUserImpl` for `userObjectId`.
 *
 * Production reaches that entrypoint as `ctx.exports.GatekeeperUserImpl({props})`
 * (`cloudflare.ts:331`), but under `@cloudflare/vitest-pool-workers` `ctx.exports` carries only the
 * classes miniflare has a binding for -- `UserAccount`, the two gatekeeper DOs, `default` -- so a
 * plain `WorkerEntrypoint` is not reachable by name. Constructing it here instead, from *inside* an
 * account DO so it gets that worker's own `ctx.exports` and `env` rather than the outer test's proxy
 * bindings, gives the real class the real `UserAccount` namespace: every storage write these tests
 * assert on is made by the production code path against a real Durable Object. `ctx` and `env` are
 * TypeScript-`protected` only, not runtime-private, so the casts are safe.
 */
async function expandScopes(
  userObjectId: DurableObjectId, patterns: string[], options?: { initiator?: { email: string } },
): Promise<{ url?: string }> {
  const ns = accounts();
  return runInDurableObject(ns.get(userObjectId), async (account: UserAccount) => {
    const inner = account as unknown as { ctx: { exports: unknown }; env: unknown };
    const user: CloudflareGatekeeperUser = new GatekeeperUserImpl(
      { props: { userObjectId: userObjectId.toString() }, exports: inner.ctx.exports } as never,
      inner.env as never);
    // An upstream caller passes no options at all, so the unbound case must not pass one either.
    return options ? user.ensureResources(patterns, options) : user.ensureResources(patterns);
  });
}

async function get(url: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await (await import("../../src/cloudflare.js")).default
    .fetch(new Request(url), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("ensureResources", () => {
  // A fresh account holds only the billing scopes, so the observability pattern is ungranted and
  // the branch that mints a reconnect link is the one that runs.
  const RESOURCES = [ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern];

  it("binds the scope-expansion link it mints to the initiator", async () => {
    const ns = accounts();
    const id = ns.newUniqueId();
    const { url } = await expandScopes(id, RESOURCES, { initiator: { email: "adam@example.com" } });
    expect(url).toMatch(new RegExp(`^${BASE}/${id}/[0-9a-f]{64}$`));

    // The initiator reached the stored nonce rather than being dropped on the way through.
    await runInDurableObject(ns.get(id), async (account: UserAccount) => {
      expect(await account.initiatorMatches("adam@example.com")).toBe(true);
      expect(await account.initiatorMatches("other@example.com")).toBe(false);
    });

    // ...so the route guard that already protects every other connect link now covers this one.
    const response = await get(url!);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(WRONG_ACCOUNT_HTML);
  });

  it("still mints an unbound link when the caller names no initiator", async () => {
    const ns = accounts();
    const id = ns.newUniqueId();
    const { url } = await expandScopes(id, RESOURCES);
    const response = await get(url!);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("dash.cloudflare.com/oauth2/auth");
  });
});
