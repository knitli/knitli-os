// The shared connect-initiator guard, used by every gatekeeper that hand-rolls its own account
// Durable Object (fork). Lives in mcp-shared's fork tree because that package runs the node pool
// and already depends on backend-utils; backend-utils' own suite runs under workerd.
import type { JWTPayload } from "jose";
import { describe, expect, it } from "vitest";
import {
  accessEmailReader,
  initiatorAllows,
  refuseForeignBrowser,
  WRONG_ACCOUNT_HTML,
} from "@gadgets/backend-utils/fork/connect-initiator";
import { WRONG_ACCOUNT_HTML as MCP_WRONG_ACCOUNT_HTML } from "../../src/html.js";

const ACCESS_ENV = { CF_ACCESS_ISS: "https://team.example.cloudflareaccess.com", CF_ACCESS_AUD: "aud" };
const noLog = { warn: () => {} };

function accountThatAllows(allowed: boolean) {
  const seen: Array<string | null> = [];
  return {
    seen,
    initiatorMatches: async (accessEmail: string | null) => { seen.push(accessEmail); return allowed; },
  };
}

describe("initiatorAllows", () => {
  it("lets anyone finish a link the host did not bind", () => {
    expect(initiatorAllows(undefined, null)).toBe(true);
    expect(initiatorAllows(undefined, "anyone@example.com")).toBe(true);
  });

  it("matches the bound person case-insensitively and refuses everyone else", () => {
    const initiator = { email: "Adam@Example.com" };
    expect(initiatorAllows(initiator, "adam@example.com")).toBe(true);
    expect(initiatorAllows(initiator, "ADAM@EXAMPLE.COM")).toBe(true);
    expect(initiatorAllows(initiator, "mallory@example.com")).toBe(false);
    // Fail closed: no verifiable identity is not the same as "the right one".
    expect(initiatorAllows(initiator, null)).toBe(false);
  });
});

describe("accessEmailReader", () => {
  it("is absent when the Worker has no Access audience", () => {
    expect(accessEmailReader({})).toBeUndefined();
    expect(accessEmailReader({ CF_ACCESS_ISS: ACCESS_ENV.CF_ACCESS_ISS })).toBeUndefined();
  });

  it("reports no identity for a browser that carries no assertion", async () => {
    const read = accessEmailReader(ACCESS_ENV);
    expect(read).toBeDefined();
    expect(await read!(new Request("https://gk.example/oauth"))).toBeNull();
  });

  it("reports the verified email claim, and null for a payload without one", async () => {
    const verified = accessEmailReader(ACCESS_ENV, async (): Promise<JWTPayload> => ({ email: "adam@example.com" }));
    const anonymous = accessEmailReader(ACCESS_ENV, async (): Promise<JWTPayload> => ({ sub: "no-email" }));
    const request = new Request("https://gk.example/oauth", {
      headers: { "cf-access-jwt-assertion": "token" },
    });
    expect(await verified!(request)).toBe("adam@example.com");
    expect(await anonymous!(request)).toBeNull();
  });
});

describe("refuseForeignBrowser", () => {
  it("returns null so the route may proceed when the account accepts the browser", async () => {
    const account = accountThatAllows(true);
    expect(await refuseForeignBrowser(new Request("https://gk.example/x"), {}, account, noLog)).toBeNull();
    // No Access config: the reader is absent, so the account is asked about a null identity.
    expect(account.seen).toEqual([null]);
  });

  it("returns a 403 page and logs the mismatch when the account refuses", async () => {
    const events: string[] = [];
    const response = await refuseForeignBrowser(
      new Request("https://gk.example/x"), ACCESS_ENV, accountThatAllows(false),
      { warn: (_message, fields) => events.push(fields.event) });

    expect(response?.status).toBe(403);
    expect(response?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await response!.text()).toBe(WRONG_ACCOUNT_HTML);
    expect(events).toEqual(["connect.initiator.mismatch"]);
  });

  it("passes a verified email through to the account, not just a boolean", async () => {
    // The optional 5th `verifier` parameter is the test seam for the positive path: a real
    // deployment behind Access has both CF_ACCESS_AUD and CF_ACCESS_ISS configured and a browser
    // that actually carries a verifiable assertion, so `initiatorMatches` sees an email, not null.
    const account = accountThatAllows(true);
    const verifier = async (): Promise<JWTPayload> => ({ email: "adam@example.com" });
    const request = new Request("https://gk.example/x", {
      headers: { "cf-access-jwt-assertion": "token" },
    });
    expect(await refuseForeignBrowser(request, ACCESS_ENV, account, noLog, verifier)).toBeNull();
    expect(account.seen).toEqual(["adam@example.com"]);
  });
});

describe("the refusal page", () => {
  it("tells a person the same thing the MCP connectors' page does", () => {
    // The frames differ on purpose -- mcp-shared styles its pages, the hand-rolled gatekeepers do
    // not -- but a person must not be told two different stories about the same refusal.
    for (const phrase of [
      "This link is not yours",
      "It was issued to a different signed-in account. Start the connection from your own account.",
    ]) {
      expect(WRONG_ACCOUNT_HTML).toContain(phrase);
      expect(MCP_WRONG_ACCOUNT_HTML).toContain(phrase);
    }
  });
});
