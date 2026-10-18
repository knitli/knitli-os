// A connect link the Workshop bound to a person must not complete for anyone else (fork).
// The Worker has no CF_ACCESS_AUD here, so every browser reads as "no verifiable identity" -- which
// a bound link must refuse and an unbound link must not notice. The identity-matching half is
// covered by `packages/mcp-shared/__tests__/fork/connect-initiator.test.ts`.
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { WRONG_ACCOUNT_HTML } from "@gadgets/observability/fork/connect-initiator";
import worker from "../../src/x";
import { scopesFor, type Env } from "../../src/x-env";
import { FakeX, accountStub, hooks, seedAccount, unwrap } from "./fake-x";

const BASE = "http://localhost:8787/gatekeeper/x";
const OWNER = { email: "adam@example.com" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function ctx() {
  return { exports: { UserAccount: env.USER_ACCOUNT } } as unknown as ExecutionContext;
}

async function armedReconnect(initiator?: typeof OWNER): Promise<{ id: string; initiation: string }> {
  const id = await seedAccount(new FakeX().install());
  const initiation = generateNonce();
  unwrap(await hooks().account(id, "prepareReconnect", initiation, scopesFor(), initiator));
  return { id, initiation };
}

describe("connect link", () => {
  it("refuses a bound link when the browser carries no verified identity", async () => {
    const { id, initiation } = await armedReconnect(OWNER);
    const response = await worker.fetch(new Request(`${BASE}/${id}/${initiation}`), env as Env, ctx());
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(WRONG_ACCOUNT_HTML);
    // Refused before the nonce was spent, so the rightful owner's link still works.
    expect(unwrap(await hooks().account(id, "initiatorMatches", OWNER.email))).toBe(true);
  });

  it("still redirects an unbound link", async () => {
    const { id, initiation } = await armedReconnect();
    const response = await worker.fetch(new Request(`${BASE}/${id}/${initiation}`), env as Env, ctx());
    expect(response.status).toBe(302);
  });
});

describe("oauth callback", () => {
  it.each([["a code", "code=test-code"], ["X's refusal", "error=access_denied"]])(
    "refuses %s for a bound flow before touching its nonce", async (_label, query) => {
      const { id, initiation } = await armedReconnect();
      const start = await worker.fetch(new Request(`${BASE}/${id}/${initiation}`), env as Env, ctx());
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      await runInDurableObject(accountStub(id), async (_instance, durable) => {
        durable.storage.kv.put("initiator", OWNER);
      });
      const response = await worker.fetch(new Request(`${BASE}/oauth?${query}&state=${state}`), env as Env, ctx());
      expect(response.status).toBe(403);
      // The attempt is still live: once unbound, X's refusal finds and ends it.
      await runInDurableObject(accountStub(id), async (_instance, durable) => {
        durable.storage.kv.delete("initiator");
      });
      const ended = await worker.fetch(new Request(`${BASE}/oauth?error=access_denied&state=${state}`),
        env as Env, ctx());
      expect(ended.status).toBe(400);
    });
});
