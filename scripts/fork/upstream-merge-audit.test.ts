import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  FORK_OWNED_PREFIXES,
  isForkOwned,
  isSourceFile,
  locateMerge,
  normalizeForFormatComparison,
} from "./upstream-merge-audit.ts";

test("reflow is normalised away, so a reformat reads as no change", () => {
  const upstreamStyle = `export function f(
      a: string, b: string): void {
  items.map(x => x + 1);
}`;
  const prettierStyle = `export function f(
  a: string,
  b: string,
): void {
  items.map((x) => x + 1);
}`;
  assert.equal(
    normalizeForFormatComparison(upstreamStyle),
    normalizeForFormatComparison(prettierStyle),
  );
});

test("a real edit survives normalisation", () => {
  const before = "let x = compute(a);";
  const after = "let x = compute(a, b);";
  assert.notEqual(normalizeForFormatComparison(before), normalizeForFormatComparison(after));
});

test("comments do not count as semantic change", () => {
  assert.equal(
    normalizeForFormatComparison("// explains why\nlet x = 1;"),
    normalizeForFormatComparison("/* explains why */ let x = 1;"),
  );
});

test("fork-owned trees are exempt, upstream-owned files are not", () => {
  assert.equal(isForkOwned("packages/gatekeeper-ai-executor/src/index.ts"), true);
  assert.equal(isForkOwned("scripts/fork/upstream-merge-audit.ts"), true);
  assert.equal(isForkOwned("packages/workshop-backend/src/overseer.ts"), false);
});

test("every declared fork-owned prefix is a path prefix, not a bare name", () => {
  for (const prefix of FORK_OWNED_PREFIXES) {
    assert.ok(
      prefix.includes("/"),
      `${prefix} must name a directory or file path so it cannot match unrelated packages`,
    );
  }
});

test("only files the normaliser can read are format-checked", () => {
  for (const path of ["src/a.ts", "src/a.tsx", "b.mjs", "c.js"]) {
    assert.equal(isSourceFile(path), true, path);
  }
  // Reflow is not a risk in these, and the JS-shaped normalisation would misread them.
  for (const path of ["pnpm-lock.yaml", "package.json", "wrangler.jsonc", "docs/x.md"]) {
    assert.equal(isSourceFile(path), false, path);
  }
});

// A real commit with no parents: the ordinary-PR case, where the branch tip is not a merge.
const rootCommit = execFileSync("git", ["rev-list", "--max-parents=0", "-n", "1", "HEAD"],
  { encoding: "utf8" }).trim();

test("a branch tip that is not a merge is 'nothing to audit', not an error", () => {
  // What CI hits on every ordinary PR. It must not fail the build.
  assert.equal(locateMerge(undefined, rootCommit), null);
});

test("an explicit --merge that is not a merge is an error", () => {
  // Being wrong about an explicit claim is worth failing on, unlike a place-to-look default.
  assert.throws(() => locateMerge(rootCommit), /not a merge commit/);
});
