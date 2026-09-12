// Guards the retirement of the host-side OpenAPI protocol (knitli-site plan 5a, 2026-09-12).
// The native connector in knitli-site (apps/os/packages/gatekeeper-openapi) needs none of this;
// anything that reintroduces a listed path or symbol is a regression, not a feature.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const RETIRED_PATHS = [
  "packages/workshop-shared/src/fork/approval-registration.ts",
  "packages/workshop-shared/src/fork/openapi-connect.ts",
  "packages/workshop-shared/src/fork/openapi-host-binding.ts",
  "packages/workshop-backend/src/fork/approval-registration.ts",
  "packages/workshop-backend/src/fork/blueprint-setup.ts",
  "packages/workshop-backend/src/fork/openapi-binding-ledger.ts",
  "packages/workshop-backend/src/fork/openapi-connect.ts",
  "packages/workshop-backend/src/fork/openapi-dispatch-binding.ts",
  "packages/workshop-backend/src/fork/openapi-facet-binding.ts",
  "packages/workshop-backend/src/fork/openapi-recovery.ts",
  "packages/workshop-backend/src/fork/openapi-user-binding.ts",
  "packages/workshop-backend/__tests__/fork-fixtures",
  "packages/workshop-frontend/src/fork/DeferredBlueprintSetup.tsx",
  "packages/integration-tests/src/fork/reload-harness.ts",
  "packages/integration-tests/fixtures/fork",
  "packages/integration-tests/fixtures/gatekeeper-test/src/fork",
];

// Word-bounded so `ensureRegistration` does not match `ensureActionRegistration`-style prose.
const RETIRED_SYMBOLS =
  "hostConnectProtocol|hostBindingProtocol|\\bensureRegistration\\b|deferredGatekeeper|workshop-shared/fork/";

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
  } catch (error) {
    // git grep / ls-files exit 1 when nothing matches, which is the pass case.
    if ((error as { status?: number }).status === 1) return "";
    throw error;
  }
}

test("retired OpenAPI host paths are not tracked", () => {
  // Tracked files only: untracked .DS_Store or wrangler output under a retired directory is noise.
  const tracked = git(["ls-files", "--", ...RETIRED_PATHS]);
  assert.equal(tracked, "", `retired paths reintroduced:\n${tracked}`);
});

test("retired OpenAPI host symbols do not appear in packages/ or scripts/", () => {
  // `git grep` honours .gitignore, so node_modules, .wrangler and dist are skipped for free.
  const hits = git(["grep", "-nE", RETIRED_SYMBOLS, "--",
    "packages", "scripts", ":!scripts/fork/openapi-host-retired.test.ts"]);
  assert.equal(hits, "", `retired symbols found:\n${hits}`);
});
