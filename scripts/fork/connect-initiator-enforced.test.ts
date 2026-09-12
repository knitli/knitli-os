// Every gatekeeper that hand-rolls its own account Durable Object must check the connect link's
// initiator before it advances the flow (fork; knitli-site plan 6a).
//
// This is a STRUCTURAL guard, not a behavioural one: it reads source, so it proves the call is
// written, not that it works. github, linear and cloudflare each have a workerd suite that proves
// the behaviour (`__tests__/workerd/knitli-connect-initiator.test.ts`). gatekeeper-email has no
// test harness at all, so for that one this file is the only guard there is -- which is why it
// checks the ordering (guard before the account call) rather than mere presence.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
