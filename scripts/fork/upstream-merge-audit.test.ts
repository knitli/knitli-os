import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  FORK_OWNED_PREFIXES,
  isForkOwned,
  isSourceFile,
  locateMerge,
  REMOVED_UPSTREAM_PATHS,
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

test("every deliberately-removed upstream path records why", () => {
  const entries = Object.entries(REMOVED_UPSTREAM_PATHS);
  assert.ok(entries.length > 0, "the list should not be silently emptied");
  for (const [path, reason] of entries) {
    assert.ok(path.includes("/"), `${path} must be a repository path`);
    // The reason is the whole point: a bare list rots into "why is this here?" within a sync or two.
    assert.ok(reason.length > 30, `${path} needs a reason someone can act on, got: ${reason}`);
  }
});

test("a merge of something that is not upstream is not treated as a sync", () => {
  // The bug this guards: this repo merges its own PRs with merge commits, so "HEAD is a merge" was
  // enough to make the audit cast our own branch as upstream and report on it.
  const headIsMerge = execFileSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"],
    { encoding: "utf8" }).trim().split(/\s+/).length > 2;
  if (!headIsMerge) return; // Nothing to discriminate on a linear branch.

  // Nothing descends from the root commit but itself, so no merge parent can be "upstream" by it.
  const root = execFileSync("git", ["rev-list", "--max-parents=0", "-n", "1", "HEAD"],
    { encoding: "utf8" }).trim();
  assert.equal(locateMerge(undefined, "HEAD", root), null);

  // Without a hint there is nothing to check against, so the merge is taken at face value.
  assert.notEqual(locateMerge(undefined, "HEAD"), null);
});
