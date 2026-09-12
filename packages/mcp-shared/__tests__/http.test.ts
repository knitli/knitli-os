import { describe, expect, it } from "vitest";

import { handleMcpHttpRequest } from "../src/http.js";

const DO_ID = "a".repeat(64);
const NONCE = "b".repeat(64);
const log = { warn() {} } as never;

function request(path: string, method = "GET") {
  return new Request(`https://workshop.example/gatekeeper/mcp${path}`, { method });
}

describe("handleMcpHttpRequest", () => {
  it.each([
    ["/elsewhere", 404],
    [`/gatekeeper/mcp/${DO_ID}/short`, 404],
    [`/gatekeeper/mcp/${"x".repeat(64)}/${NONCE}`, 400],
  ])("returns the expected status for %s", async (path, status) => {
    const response = await handleMcpHttpRequest(
      new Request(`https://workshop.example${path}`),
      {
        baseUrl: "https://workshop.example/gatekeeper/mcp",
        accountForId(id) {
          if (id !== DO_ID) throw new Error("invalid id");
          return { acceptAuthCode: async () => true, initiatorMatches: async () => true };
        },
        log,
        connect: async () => new Response("connected"),
      },
    );

    expect(response.status).toBe(status);
  });

  it("delegates a valid connect link without imposing connector method policy", async () => {
    const response = await handleMcpHttpRequest(request(`/${DO_ID}/${NONCE}`, "POST"), {
      baseUrl: "https://workshop.example/gatekeeper/mcp",
      accountForId: () => ({ acceptAuthCode: async () => true, initiatorMatches: async () => true }),
      log,
      connect: async (req, _account, nonce, path) =>
        Response.json({ method: req.method, nonce, path }),
    });

    expect(await response.json()).toEqual({
      method: "POST",
      nonce: NONCE,
      path: `/gatekeeper/mcp/${DO_ID}/${NONCE}`,
    });
  });

  it("dispatches the OAuth callback through the same account resolver", async () => {
    const response = await handleMcpHttpRequest(
      request(`/oauth?code=code&state=${DO_ID}:${NONCE}`),
      {
        baseUrl: "https://workshop.example/gatekeeper/mcp",
        accountForId: () => ({ acceptAuthCode: async () => true, initiatorMatches: async () => true }),
        log,
        connect: async () => new Response("unexpected"),
      },
    );

    expect(response.status).toBe(200);
  });

  it("refuses the connect link and the callback for a browser that is not the initiator", async () => {
    const calls: string[] = [];
    const options = {
      baseUrl: "https://workshop.example/gatekeeper/mcp",
      accountForId: () => ({
        acceptAuthCode: async () => { calls.push("acceptAuthCode"); return true; },
        initiatorMatches: async (email: string | null) => email === "adam@example.com",
      }),
      log,
      accessEmail: async (req: Request) => req.headers.get("x-test-email"),
      connect: async () => { calls.push("connect"); return new Response("connected"); },
    };
    const foreign = { headers: { "x-test-email": "mallory@example.com" } };

    const link = await handleMcpHttpRequest(
      new Request(`https://workshop.example/gatekeeper/mcp/${DO_ID}/${NONCE}`, foreign), options);
    const callback = await handleMcpHttpRequest(
      new Request(`https://workshop.example/gatekeeper/mcp/oauth?code=code&state=${DO_ID}:${NONCE}`, foreign),
      options);

    expect(link.status).toBe(403);
    expect(callback.status).toBe(403);
    expect(await link.text()).toContain("not yours");
    expect(calls).toEqual([]);
  });

  it("lets the initiator through and reports no identity when Access is not configured", async () => {
    const seen: Array<string | null> = [];
    const account = {
      acceptAuthCode: async () => true,
      initiatorMatches: async (email: string | null) => { seen.push(email); return true; },
    };
    const withAccess = await handleMcpHttpRequest(
      new Request(`https://workshop.example/gatekeeper/mcp/${DO_ID}/${NONCE}`,
        { headers: { "x-test-email": "adam@example.com" } }),
      {
        baseUrl: "https://workshop.example/gatekeeper/mcp",
        accountForId: () => account,
        log,
        accessEmail: async (req: Request) => req.headers.get("x-test-email"),
        connect: async () => new Response("connected"),
      });
    const withoutAccess = await handleMcpHttpRequest(
      new Request(`https://workshop.example/gatekeeper/mcp/oauth?code=code&state=${DO_ID}:${NONCE}`),
      {
        baseUrl: "https://workshop.example/gatekeeper/mcp",
        accountForId: () => account,
        log,
        connect: async () => new Response("unexpected"),
      });

    expect(withAccess.status).toBe(200);
    expect(withoutAccess.status).toBe(200);
    expect(seen).toEqual(["adam@example.com", null]);
  });
});
