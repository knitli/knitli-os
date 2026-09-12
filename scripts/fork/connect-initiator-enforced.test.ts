// Each gatekeeper that hand-rolls its own account Durable Object AND is used by this installation
// must check the connect link's initiator before it advances the flow (fork; knitli-site plan 6a).
// Four of the twelve are in that set; the other eight are named in OUT_OF_SCOPE below, and the
// last test here fails if a thirteenth appears in neither list.
//
// This is a STRUCTURAL guard, not a behavioural one: it reads source, so it proves the call is
// written, not that it works. github, linear and cloudflare each have a workerd suite that proves
// the behaviour (`__tests__/workerd/knitli-connect-initiator.test.ts`). gatekeeper-email has no
// test harness at all, so for that one this file is the only guard there is -- which is why it
// checks the ordering (guard before the account call) rather than mere presence.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** Each gatekeeper, and the account calls that must not be reachable without the guard. */
const HAND_ROLLED: Array<{ file: string; guarded: string[] }> = [
  { file: "packages/gatekeeper-github/src/github.ts", guarded: ["beginOAuthFlow", "acceptAuthCode"] },
  { file: "packages/gatekeeper-linear/src/linear.ts", guarded: ["beginOAuthFlow", "acceptAuthCode"] },
  { file: "packages/gatekeeper-cloudflare/src/cloudflare.ts", guarded: ["beginOAuthFlow", "acceptAuthCode"] },
  // No OAuth step: the connect link itself completes the account, so `complete` is the only call.
  { file: "packages/gatekeeper-email/src/email.ts", guarded: ["complete"] },
];

for (const { file, guarded } of HAND_ROLLED) {
  test(`${file} stores and compares the connect initiator`, () => {
    const source = read(file);
    assert.match(source, /from "@gadgets\/backend-utils\/fork\/connect-initiator"/,
      `${file} does not import the shared connect-initiator guard`);
    assert.match(source, /async initiatorMatches\(accessEmail: string \| null\): Promise<boolean>/,
      `${file}'s account Durable Object does not expose initiatorMatches`);
    assert.match(source, /initiatorAllows\(/, `${file} does not compare against the stored initiator`);
  });

  test(`${file} refuses a foreign browser before every account call`, () => {
    const source = read(file);
    const refusals = [...source.matchAll(/await refuseForeignBrowser\(/g)].map((m) => m.index ?? -1);
    assert.equal(refusals.length, guarded.length,
      `${file} has ${refusals.length} refuseForeignBrowser call(s), expected ${guarded.length}`);
    for (const method of guarded) {
      // `stub.<method>(` is the account call; some other `<method>(` in the file (a definition, a
      // different receiver) must not satisfy this, hence the `stub.` prefix.
      const call = source.indexOf(`stub.${method}(`);
      assert.notEqual(call, -1, `${file} no longer calls stub.${method}(`);
      const guard = refusals.filter((at) => at < call).at(-1);
      assert.notEqual(guard, undefined, `${file} calls stub.${method}( with no preceding refusal`);
      // The guard must be the nearest thing above the call, not a leftover from an earlier route.
      assert.ok(call - guard! < 400,
        `${file}'s refusal is ${call - guard!} characters above stub.${method}(, which is another route's`);
    }
  });
}

/**
 * The hand-rolled gatekeepers this installation does not use, and so did not fix. Left exactly as
 * upstream wrote them: their connect links are still good for whoever holds the nonce.
 *
 * This is a record of a decision, not a backlog -- but adopting one of these means fixing it and
 * moving it into HAND_ROLLED, which is what the discovery test below is here to force.
 */
const OUT_OF_SCOPE: Record<string, string> = {
  "packages/gatekeeper-confluence/src/confluence.ts": "not used by this installation (owner decision, 2026-09-12)",
  "packages/gatekeeper-google/src/google.ts": "not used by this installation (owner decision, 2026-09-12)",
  "packages/gatekeeper-homeassistant/src/homeassistant.ts": "not used by this installation (owner decision, 2026-09-12)",
  "packages/gatekeeper-notion/src/notion.ts": "not used by this installation (owner decision, 2026-09-12)",
  "packages/gatekeeper-slack/src/slack.ts": "not used by this installation (owner decision, 2026-09-12)",
  "packages/gatekeeper-spotify/src/spotify.ts": "not used by this installation (owner decision, 2026-09-12)",
  "packages/gatekeeper-supabase/src/supabase.ts": "not used by this installation (owner decision, 2026-09-12)",
  "packages/gatekeeper-zoominfo/src/zoominfo.ts": "not used by this installation (owner decision, 2026-09-12)",
};

/**
 * A `setCallback(` *definition* -- a method on an account class -- as opposed to a call through
 * some receiver, which always has a `.` before it. Defining one is what "hand-rolls its own account
 * Durable Object" means here: it is the method the Workshop hands the connect callback to, and the
 * point at which an initiator either is or is not stored.
 */
const DEFINES_SET_CALLBACK = /^[ \t]+(?:async[ \t]+)?setCallback\(/m;

/** Every TypeScript source under a `packages/gatekeeper-…` that defines its own `setCallback`. */
function handRolledGatekeepers(): string[] {
  const found: string[] = [];
  for (const pkg of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!pkg.isDirectory() || !pkg.name.startsWith("gatekeeper-")) continue;
    const src = join(root, "packages", pkg.name, "src");
    if (!existsSync(src)) continue;
    for (const name of readdirSync(src)) {
      const file = `packages/${pkg.name}/src/${name}`;
      if (name.endsWith(".ts") && DEFINES_SET_CALLBACK.test(read(file))) found.push(file);
    }
  }
  return found.toSorted();
}

/**
 * The lists above are hand-maintained, and a gatekeeper added later would be in neither -- passing
 * this file's per-file tests vacuously, with no initiator support at all and nothing to say so. So
 * the set is discovered from source and reconciled against them in both directions: an unlisted
 * gatekeeper fails, and so does a listed one that stopped hand-rolling (which would mean the
 * discovery had silently gone blind, and every other assertion here with it).
 *
 * The MCP family is deliberately absent: it defines no `setCallback` of its own, routing through
 * `McpAccountBase` (`packages/mcp-shared/src/account.ts`), which is covered below and by
 * `packages/mcp-shared/__tests__/fork/connect-initiator.test.ts`.
 */
test("every hand-rolled gatekeeper is fixed or a named exemption", () => {
  const found = handRolledGatekeepers();
  const listed = [...HAND_ROLLED.map(({ file }) => file), ...Object.keys(OUT_OF_SCOPE)].toSorted();

  assert.deepEqual(found.filter((file) => !listed.includes(file)), [],
    "hand-rolls its own connect flow but is in neither HAND_ROLLED nor OUT_OF_SCOPE: fix it and " +
    "add it to HAND_ROLLED, or record why it is exempt");
  assert.deepEqual(listed.filter((file) => !found.includes(file)), [],
    "listed here but no longer defines its own setCallback( -- either it moved to a shared base " +
    "(drop the entry) or DEFINES_SET_CALLBACK has gone blind (fix it; these tests depend on it)");
});

/**
 * The MCP family routes through `handleMcpHttpRequest`, which enforces the initiator itself
 * (`packages/mcp-shared/src/http.ts`). What can silently break here is the wiring: an
 * `accessEmail` option that is absent, or one that re-implements the reader instead of using the
 * shared one, would make every browser read as anonymous and refuse every bound link.
 */
const MCP_WORKERS = [
  "packages/gatekeeper-mcp/src/mcp.ts",
  "packages/gatekeeper-mcp-portal/src/portal.ts",
];

for (const file of MCP_WORKERS) {
  test(`${file} hands handleMcpHttpRequest the shared Access email reader`, () => {
    const source = read(file);
    assert.match(source, /accessEmail: accessEmailReader\(env\)/,
      `${file} does not pass accessEmailReader(env) to handleMcpHttpRequest`);
    assert.match(source, /from "@gadgets\/backend-utils\/fork\/connect-initiator"/,
      `${file} does not import the shared reader`);
    assert.doesNotMatch(source, /verifyCfAccessJwt/,
      `${file} still re-implements the reader; use accessEmailReader so one place is tested`);
  });
}
