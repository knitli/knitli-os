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

type Answer = { status: number; body: string; cacheControl?: string };
// Per row, a request that only its handler answers, sent with the method the TABLE declares, so a
// handler that changes verb leaves the row stale and this red. `ok` is that answer; it need not be
// a 2xx, only differ from the router's 404. `wrong` is a method the handler refuses, where it
// checks one, with its answer.
const SAME_ORIGIN = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document" };
const PROBES: Record<string, { params?: Record<string, string>; headers?: HeadersInit; ok: Answer;
    wrong?: { method: string } & Answer }> = {
  routerTagProbe: { ok: { status: 204, body: "", cacheControl: "no-store" },
      wrong: { method: "GET", status: 404, body: "Not Found" } },
  siteLogo: {
      ok: { status: 404, body: "Not Found", cacheControl: "no-store" },
      wrong: { method: "POST", status: 405, body: "Method Not Allowed" } },
  // Seeded below: a missing screenshot is the same plain 404 as no route.
  blueprintScreenshot: { params: { blueprintId: "probe" }, ok: { status: 200, body: "png",
      cacheControl: "public, max-age=31536000, immutable" } },
  clientErrors: {
      ok: { status: 403, body: "Cross-origin API access not allowed." },
      wrong: { method: "GET", status: 405, body: "Method Not Allowed" } },
  mcp: { params: { gadgetId: HEX64, gatekeeperId: "0" }, ok: { status: 401, body: "Workshop bearer credential required." },
      wrong: { method: "GET", status: 405, body: "Only POST is supported." } },
  // Reaches the session object, which wants a WebSocket upgrade and a live token. No code looks at
  // the verb: an upgrade is a GET by definition, so the test below pins the row to GET.
  voice: { params: { sessionId: HEX64 }, headers: { Origin: ORIGIN, Upgrade: "websocket" },
      ok: { status: 403, body: "Voice connection expired" } },
  deviceSessionCallback: { headers: SAME_ORIGIN,
      ok: { status: 400, body: "Invalid device session request.", cacheControl: "no-store" },
      wrong: { method: "GET", status: 403, body: "Invalid device session request.",
          cacheControl: "no-store" } },
  rpc: { ok: { status: 200, body: "" },
      wrong: { method: "GET", status: 400,
          body: "This endpoint only accepts POST or WebSocket requests." } },
};

/** The method the table declares for a row. */
const declaredMethod = (name: string) => WORKSHOP_ROUTES.find((r) => r.name === name)!.method;

/** The path a probe hits: the row's own path, with each `:param` filled from the probe. */
function probePath(name: string, params: Record<string, string> = {}): string {
  const path = WORKSHOP_ROUTES.find((r) => r.name === name)!.path.replace(
      /:(\w+)/g, (_, key: string) => params[key] ?? `:${key}`);
  if (path.includes("/:")) throw new Error(`${name}: probe has no sample for a param in ${path}`);
  return path;
}

async function send(method: string, path: string, headers?: HeadersInit): Promise<Answer> {
  const response = await server.fetch(
    new Request(ORIGIN + path, { method, headers }), publisherOn, createExecutionContext());
  const cacheControl = response.headers.get("Cache-Control") ?? undefined;
  return { status: response.status, body: await response.text(),
      ...(cacheControl === undefined ? {} : { cacheControl }) };
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

  it("reads every use of pathname in server.ts, or names the line it cannot read", () => {
    // `const { pathname } = url`, `u.pathname`, `url["pathname"]` and the like would route past
    // the scan above, so any pathname token it did not read on its own line fails.
    const read = /url\.pathname(?:\.startsWith\(\s*|\s*===\s*)(?:"[^"]*"|[A-Z_]+)|url\.pathname\.slice\(/g;
    const unread = source.split("\n").flatMap((text, i) =>
        (text.match(/\bpathname\b/g)?.length ?? 0) === (text.match(read)?.length ?? 0)
            ? [] : [`server.ts:${i + 1}: ${text.trim()}`]);
    expect(unread).toEqual([]);
  });

  it("has a probe for every row", () => {
    expect(Object.keys(PROBES).toSorted()).toEqual(WORKSHOP_ROUTES.map((r) => r.name).toSorted());
  });

  it.each(Object.entries(PROBES))("serves %s through its handler, by the declared method",
      async (name, probe) => {
    expect(await send(declaredMethod(name), probePath(name, probe.params), probe.headers)).toEqual(probe.ok);
  });

  it.each(Object.entries(PROBES).filter(([, p]) => p.wrong))(
      "%s refuses a method its row does not declare", async (name, probe) => {
    expect(probe.wrong!.method).not.toBe(declaredMethod(name));
    expect(await send(probe.wrong!.method, probePath(name, probe.params), probe.headers))
        .toEqual({ status: probe.wrong!.status, body: probe.wrong!.body,
            ...(probe.wrong!.cacheControl === undefined ? {}
                : { cacheControl: probe.wrong!.cacheControl }) });
  });

  it("declares the voice route as GET, the only verb a WebSocket upgrade has", () => {
    expect(declaredMethod("voice")).toBe("GET");
  });

  it("serves blueprint screenshots to any verb, so only the schema narrows the row to GET", async () => {
    // server.ts is upstream's and never looks at the verb; the table row records what the WAF
    // schema should allow. If this starts refusing other verbs, the row is no longer the only limit.
    for (const verb of ["GET", "POST", "PUT", "DELETE"]) {
      expect(await send(verb, probePath("blueprintScreenshot", { blueprintId: "probe" })))
          .toMatchObject({ status: 200, body: "png" });
    }
    expect(declaredMethod("blueprintScreenshot")).toBe("GET");
  });

  it("answers a bad voice session id with the handler's own 404", async () => {
    expect(await send("GET", probePath("voice", { sessionId: "not-a-session" }), { Origin: ORIGIN }))
        .toEqual({ status: 404, body: "Invalid voice session" });
  });

  it("answers a path with no row with the router's own 404", async () => {
    expect(await send("GET", "/api/nope")).toEqual({ status: 404, body: "Not Found" });
  });
});
