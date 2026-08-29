import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ancestry,
  auditRemovedPaths,
  authoritativeUpstreamRef,
  FORK_OWNED_PREFIXES,
  isForkOwned,
  isShallowRepository,
  isSourceFile,
  locateMerge,
  normalizeForFormatComparison,
  REMOVED_UPSTREAM_PATHS,
  UsageError,
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

test("a branch tip that is not a merge is 'nothing to audit', not an error", () => {
  // What CI hits on every ordinary PR. It must not fail the build.
  const dir = scratchRepo();
  try {
    inRepo(dir, () => assert.equal(locateMerge(undefined, "HEAD"), null));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit --merge that is not a merge is an error", () => {
  // Being wrong about an explicit claim is worth failing on, unlike a place-to-look default.
  const dir = scratchRepo();
  try {
    inRepo(dir, () => assert.throws(() => locateMerge("HEAD"), /not a merge commit/));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("an explicit upstream ref that does not resolve is a usage error, not a fallback", () => {
  // Falling back would audit against a baseline the caller did not ask for and still exit 0, which
  // an automated caller would read as a pass.
  assert.throws(() => authoritativeUpstreamRef("refs/heads/definitely-not-a-real-ref"),
    UsageError);
});

test("an absent upstream ref is not an error, just nothing to compare against", () => {
  // Distinct from the case above: no argument was given, so nothing was promised.
  assert.doesNotThrow(() => authoritativeUpstreamRef(undefined));
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

test("ancestry separates a definitive no from an unanswerable question", () => {
  // Built in a scratch repo rather than against this one: CI checks out shallow, where
  // `rev-list --max-parents=0` returns HEAD itself and the question answers itself.
  const dir = scratchRepo();
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  try {
    const base = run("rev-parse", "main");
    const upstreamTip = run("rev-parse", "upstream");
    inRepo(dir, () => {
      assert.equal(isShallowRepository(), false, "the scratch repo has complete history");
      assert.equal(ancestry(base, upstreamTip), "yes");
      assert.equal(ancestry(upstreamTip, base), "no");
      // git exits 128 here, not 1. Reading that as "no" is what demotes a real sync to an
      // ordinary merge and skips its audit.
      assert.equal(ancestry("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", base), "unknown");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history git cannot traverse is audited, not skipped", () => {
  // The shallow-clone case: the upstream tip cannot be traced back to the sync's second parent, so
  // ancestry is unanswerable. The merge must still be audited, and must be marked unverified.
  const dir = scratchRepo();
  try {
    execFileSync("git", ["-C", dir, "merge", "--no-commit", "--no-ff", "upstream"],
      { encoding: "utf8", stdio: "pipe" });
    inRepo(dir, () => {
      const merge = locateMerge(undefined, "HEAD", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
      assert.ok(merge, "an unanswerable ancestry must not skip the merge");
      assert.equal(merge.classification, "unverified");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a shallow boundary reports a false 'no', which must not be trusted", () => {
  // The scenario, reproduced rather than approximated: `main` cloned at depth 1, then the true
  // ancestor A fetched separately so the object is present locally but sits behind main's shallow
  // boundary. Git treats that boundary as a root, so it exits 1 -- a confident "not an ancestor"
  // for a commit that genuinely is one. Reading that as "no" skips a real sync's audit.
  const origin = mkdtempSync(join(tmpdir(), "fork-audit-origin-"));
  const shallow = mkdtempSync(join(tmpdir(), "fork-audit-shallow-"));
  const run = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  try {
    run(origin, "init", "-q", "-b", "main");
    run(origin, "config", "user.email", "test@example.invalid");
    run(origin, "config", "user.name", "Test");
    run(origin, "commit", "-q", "--allow-empty", "-m", "A");
    const ancestorCommit = run(origin, "rev-parse", "HEAD");
    run(origin, "branch", "side");
    run(origin, "commit", "-q", "--allow-empty", "-m", "B");
    run(origin, "commit", "-q", "--allow-empty", "-m", "C");

    execFileSync("git", ["clone", "-q", "--depth=1", `file://${origin}`, shallow],
      { encoding: "utf8", stdio: "pipe" });
    // Brings A into the object store without deepening main's history.
    run(shallow, "fetch", "-q", "--depth=1", "origin", "side");

    inRepo(shallow, () => {
      assert.equal(isShallowRepository(), true);
      assert.equal(run(shallow, "cat-file", "-t", ancestorCommit), "commit",
        "the ancestor object must be present locally for this to be the reported case");
      // Git's own answer here is a false 1. The point of the check is that we do not repeat it.
      assert.equal(ancestry(ancestorCommit, "origin/main"), "unknown",
        "a shallow boundary cannot support a definitive 'no'");
    });
  } finally {
    rmSync(origin, { recursive: true, force: true });
    rmSync(shallow, { recursive: true, force: true });
  }
});

test("a path that cannot be read is not reported as absent", () => {
  // `git show ref:path` fails identically for "not in that tree" and "that ref is unreadable".
  // Reading the second as absence silently drops a file from the dropped-hunk audit, and makes a
  // deliberately-removed file look like it is still removed.
  const dir = scratchRepo();
  try {
    inRepo(dir, () => {
      // A genuine absence: the ref is fine, the path is not there.
      assert.equal(auditRemovedPaths("HEAD").length, 0);
      // A broken ref must raise rather than answer "absent" for everything.
      assert.throws(() => auditRemovedPaths("refs/heads/no-such-branch"),
        /cannot read|not a valid/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const AUDIT_CLI = fileURLToPath(new URL("./upstream-merge-audit.ts", import.meta.url));

/** Runs the CLI in `dir` and returns its exit status. */
function runAudit(dir: string, ...args: string[]): number {
  try {
    execFileSync("node", [AUDIT_CLI, ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

test("an audit that could not run its checks does not exit 0", () => {
  // A scratch repo has no `foundation` remote, so there is nothing to compare against and both
  // checks are skipped. Exiting 0 would let a shell script read that as a pass.
  const dir = scratchRepo();
  try {
    assert.equal(runAudit(dir), 2, "an untrustworthy audit must not report success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exit codes distinguish clean, findings, and could-not-check", () => {
  const dir = scratchRepo();
  try {
    // Could not be honoured: an explicit ref that does not resolve.
    assert.equal(runAudit(dir, "--upstream", "refs/heads/nope"), 2);
    // Trustworthy and clean: an upstream ref that exists, nothing diverging in a fresh repo.
    assert.equal(runAudit(dir, "--upstream", "upstream"), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
