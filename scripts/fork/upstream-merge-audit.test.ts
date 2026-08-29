import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  authoritativeUpstreamRef,
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

test("an upstream ref that does not resolve is not silently accepted", () => {
  assert.equal(authoritativeUpstreamRef("refs/heads/definitely-not-a-real-ref"), null);
});

test("an explicit upstream ref that resolves is used as given", () => {
  assert.equal(authoritativeUpstreamRef("HEAD"), "HEAD");
});

test("upstream is never derived from local history", () => {
  // The bug this guards: the old fallback took "second parent of the most recent merge", which on
  // a repo that merges its own PRs is one of our own branches -- so the formatting check compared
  // the tree against itself and was clean by construction.
  const withoutRemote = authoritativeUpstreamRef(undefined);
  if (withoutRemote === null) return; // No foundation remote fetched here; nothing to assert.
  assert.equal(withoutRemote, "foundation/main",
    "the only non-explicit source of truth is the upstream remote");
});

/**
 * A throwaway repo with three lines of history: a shared base, an `upstream` branch, and an
 * unrelated `feature` branch. Enough to ask "is this merge a sync?" for real.
 */
function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fork-audit-repo-"));
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.invalid");
  run("config", "user.name", "Test");
  run("commit", "-q", "--allow-empty", "-m", "base");
  run("branch", "upstream");
  run("branch", "feature");
  run("checkout", "-q", "upstream");
  run("commit", "-q", "--allow-empty", "-m", "upstream work");
  run("checkout", "-q", "feature");
  run("commit", "-q", "--allow-empty", "-m", "feature work");
  run("checkout", "-q", "main");
  return dir;
}

function inRepo<T>(dir: string, body: () => T): T {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return body();
  } finally {
    process.chdir(previous);
  }
}

test("an in-progress merge of a non-upstream branch is not a sync", () => {
  // Regression: the MERGE_HEAD path used to return before the upstream check, so merging an
  // ordinary local branch made the audit treat that branch as upstream.
  const dir = scratchRepo();
  try {
    execFileSync("git", ["-C", dir, "merge", "--no-commit", "--no-ff", "feature"],
      { encoding: "utf8", stdio: "pipe" });
    inRepo(dir, () => {
      assert.equal(locateMerge(undefined, "HEAD", "upstream"), null,
        "merging `feature` is not a sync just because a merge is in progress");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an in-progress merge of upstream is a sync", () => {
  const dir = scratchRepo();
  try {
    execFileSync("git", ["-C", dir, "merge", "--no-commit", "--no-ff", "upstream"],
      { encoding: "utf8", stdio: "pipe" });
    inRepo(dir, () => {
      const merge = locateMerge(undefined, "HEAD", "upstream");
      assert.ok(merge, "merging upstream is a sync and must be audited");
      assert.match(merge.description, /merge in progress/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
