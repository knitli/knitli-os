// The Worker's route table (src/fork/workshop-routes.ts). workshop-routes.json is what knitli-site's
// WAF route check reads, so a route cannot change without it showing here.
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { BLUEPRINT_SCREENSHOT_PATH_PREFIX, BLUEPRINT_SCREENSHOT_R2_PREFIX, ROUTER_TAG_PROBE_PATH } from "@gadgets/workshop-shared/api";
import server from "../src/server";
import source from "../src/server.ts?raw";
import { WORKSHOP_ROUTES } from "../src/fork/workshop-routes";
import { SITE_LOGO_PATH } from "../src/site-logo";

const ORIGIN = "https://workshop.example";
const HEX64 = "a".repeat(64);
// Read-only view: the publisher is off in the test env, and `env` is shared by the whole file.
const publisherOn = new Proxy(env, {
  get: (target, key) => key === "OPENAPI_MCP_PUBLISHER_ENABLED" ? "true" : Reflect.get(target, key),
});

// One request per row that only its handler answers, so a 404 from the router cannot pass for it.
// `wrong` is a method the handler refuses, where it checks one.
const PROBES: Record<string, { method: string; path: string; headers?: HeadersInit;
    status: number; body: string; wrong?: { method: string; status: number } }> = {
  routerTagProbe: { method: "POST", path: "/api/router-tag", status: 204, body: "" },
  siteLogo: { method: "GET", path: "/api/site-logo", status: 404, body: "Not Found",
      wrong: { method: "POST", status: 405 } },
  // Seeded below: a missing screenshot is the same plain 404 as no route.
  blueprintScreenshot: { method: "GET", path: "/blueprint-screenshot/probe", status: 200, body: "png" },
  clientErrors: { method: "GET", path: "/api/client-errors", status: 405, body: "Method Not Allowed" },
  mcp: { method: "GET", path: `/api/mcp/${HEX64}/0`, status: 405, body: "Only POST is supported." },
  voice: { method: "GET", path: "/api/voice/not-a-session", headers: { Origin: ORIGIN },
      status: 404, body: "Invalid voice session" },
  deviceSessionCallback: { method: "GET", path: "/api/device-session/callback", status: 403,
      body: "Invalid device session request." },
  rpc: { method: "GET", path: "/api", status: 400,
      body: "This endpoint only accepts POST or WebSocket requests." },
};

async function send(method: string, path: string, headers?: HeadersInit) {
  const response = await server.fetch(
    new Request(ORIGIN + path, { method, headers }), publisherOn, createExecutionContext());
  return { status: response.status, body: await response.text() };
}

describe("workshop route table", () => {
  it("matches the committed workshop-routes.json (regenerate with `vitest -u`)", async () => {
    await expect(`${JSON.stringify(WORKSHOP_ROUTES, null, 2)}\n`)
        .toMatchFileSnapshot("../workshop-routes.json");
  });

  it("has unique names and paths", () => {
    const names = WORKSHOP_ROUTES.map((r) => r.name);
    const paths = WORKSHOP_ROUTES.map((r) => r.path);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("workshop route table against server.ts", () => {
  beforeAll(() => env.BLUEPRINT_CONTENT.put(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}probe`, "png"));

  // The constants server.ts compares `url.pathname` with; an unknown one fails until it is added.
  const CONSTANTS: Record<string, string> = {
    ROUTER_TAG_PROBE_PATH,
    SITE_LOGO_PATH,
    BLUEPRINT_SCREENSHOT_PATH_PREFIX,
  };
  const literals = [
    ...source.matchAll(/url\.pathname(\.startsWith\(|\s*===\s*)\s*("[^"]*"|[A-Z_]+)/g),
  ].map(([, op, operand]) => {
    const value = operand!.startsWith('"') ? operand!.slice(1, -1) : CONSTANTS[operand!];
    if (value === undefined) throw new Error(`server.ts routes on ${operand}; resolve it in CONSTANTS`);
    return { prefix: op!.startsWith(".startsWith"), value };
  });

  it("finds the routes server.ts dispatches on", () => {
    expect(literals.length).toBeGreaterThanOrEqual(WORKSHOP_ROUTES.length - 1);
  });

  it("has a row for every route literal server.ts dispatches on", () => {
    // A prefix is covered by a row under it; /api/mcp is forwarded wholesale to /api/mcp/:id/:id.
    const uncovered = literals.filter(({ prefix, value }) => !WORKSHOP_ROUTES.some(({ path }) =>
        prefix ? path.startsWith(value) : path === value || path.startsWith(`${value}/:`)));
    expect(uncovered).toEqual([]);
  });

  it("does not route on url.pathname in a form the scan cannot read", () => {
    const uses = source.match(/url\.pathname/g)!.length;
    const read = literals.length + source.match(/url\.pathname\.slice\(/g)!.length;
    expect(uses).toBe(read);
  });

  it("has a probe for every row", () => {
    expect(Object.keys(PROBES).toSorted()).toEqual(WORKSHOP_ROUTES.map((r) => r.name).toSorted());
  });

  it.each(Object.entries(PROBES))("serves %s through its handler", async (_name, probe) => {
    expect(await send(probe.method, probe.path, probe.headers))
        .toEqual({ status: probe.status, body: probe.body });
  });

  it.each(Object.entries(PROBES).filter(([, p]) => p.wrong))(
      "%s refuses a method its row does not declare", async (_name, probe) => {
    expect((await send(probe.wrong!.method, probe.path, probe.headers)).status)
        .toBe(probe.wrong!.status);
  });

  it("answers a path with no row with the router's own 404", async () => {
    expect(await send("GET", "/api/nope")).toEqual({ status: 404, body: "Not Found" });
  });
});
