import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker, { UserAccount } from "../src/microsoft";

// Connect links the Workshop binds to a person (fork): only that person's Cloudflare Access session
// may advance them. These deployments have no Access audience here, so a bound link is refused
// outright (fail closed), while an unbound one behaves exactly as upstream's did.

const BASE_URL = "https://gatekeeper.example/gatekeeper/microsoft";
const DO_ID = "a".repeat(64);
const NONCE = "n".repeat(64);
const SCOPES = ["openid", "profile", "email", "User.Read", "offline_access"];
const INITIATOR = { email: "owner@example.com" };

const env = {
  CLIENT_ID: "client-id",
  CLIENT_SECRET: "client-secret",
  TENANT_ID: "11111111-2222-3333-4444-555555555555",
  BASE_URL,
};

let account: UserAccount;
let executionContext: unknown;

beforeEach(() => {
  const values = new Map<string, unknown>();
  account = new UserAccount({
    waitUntil: vi.fn(),
    id: { toString: () => DO_ID },
    storage: {
      setAlarm: vi.fn(),
      deleteAlarm: vi.fn(),
      deleteAll: vi.fn(() => values.clear()),
      kv: {
        get<T>(key: string) { return values.get(key) as T | undefined; },
        put<T>(key: string, value: T) { values.set(key, value); },
        delete(key: string) { values.delete(key); },
      },
    },
    exports: {},
  } as never, env as never);
  executionContext = {
    exports: {
      UserAccount: { idFromString: (id: string) => ({ toString: () => id }), get: () => account },
    },
  };
});

afterEach(() => vi.restoreAllMocks());

describe("initiatorMatches", () => {
  it("lets anyone continue a link issued without an initiator", async () => {
    await account.setCallback({} as never, NONCE, SCOPES, false);

    await expect(account.initiatorMatches(null)).resolves.toBe(true);
    await expect(account.initiatorMatches("someone@example.com")).resolves.toBe(true);
  });

  it("holds a bound link to its initiator, compared case-insensitively", async () => {
    await account.setCallback({} as never, NONCE, SCOPES, false, INITIATOR);

    await expect(account.initiatorMatches("Owner@Example.com")).resolves.toBe(true);
    await expect(account.initiatorMatches("someone@example.com")).resolves.toBe(false);
    await expect(account.initiatorMatches(null)).resolves.toBe(false);
  });

  it("binds a reconnect link too, and keeps the binding through the OAuth stage", async () => {
    await account.prepareReconnect(NONCE, SCOPES, INITIATOR);
    await expect(account.initiatorMatches("someone@example.com")).resolves.toBe(false);

    await account.beginOAuthFlow(NONCE);
    await expect(account.initiatorMatches("someone@example.com")).resolves.toBe(false);
    await expect(account.initiatorMatches(INITIATOR.email)).resolves.toBe(true);
  });
});

describe("connect routes", () => {
  it("refuses a browser that is not the initiator before the nonce is consumed", async () => {
    await account.setCallback({} as never, NONCE, SCOPES, false, INITIATOR);

    const response = await worker.fetch(
      new Request(`${BASE_URL}/${DO_ID}/${NONCE}`), env as never, executionContext as never);

    expect(response.status).toBe(403);
    // The refusal consumed nothing: the rightful owner can still use the link.
    await expect(account.beginOAuthFlow(NONCE)).resolves.not.toBeNull();
  });

  it("refuses the OAuth callback from a browser that is not the initiator", async () => {
    await account.setCallback({} as never, NONCE, SCOPES, false, INITIATOR);
    const begun = await account.beginOAuthFlow(NONCE);

    const response = await worker.fetch(
      new Request(`${BASE_URL}/oauth?code=c&state=${DO_ID}:${begun!.oauthNonce}`),
      env as never, executionContext as never);

    expect(response.status).toBe(403);
  });

  it("still redirects a link issued without an initiator", async () => {
    await account.setCallback({} as never, NONCE, SCOPES, false);

    const response = await worker.fetch(
      new Request(`${BASE_URL}/${DO_ID}/${NONCE}`), env as never, executionContext as never);

    expect(response.status).toBe(302);
  });
});
