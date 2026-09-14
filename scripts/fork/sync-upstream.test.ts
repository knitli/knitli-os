import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { forkBoundary } from "./fork-boundary.ts";
import {
  applyMergePolicy,
  attributeRemoval,
  auditCommand,
  findSurvivors,
  findTier1References,
  forkTouchedFiles,
  isCompoundName,
  mergeHeadPresent,
  planSync,
  preflightStart,
  removedIdentifiers,
  resolveVerifyContext,
  survivingTokens,
  typecheckPlan,
  unmergedPaths,
} from "./sync-upstream.ts";
import { UsageError } from "./upstream-merge-audit.ts";

// Fixture paths follow the live boundary rather than hardcoding it: the Tier-1 probe lives under
// the first Tier-1 directory, and the removed file is the first recorded removal.
const TIER1_DIR = forkBoundary().forkOwned.find(entry => entry.path.endsWith("/"))!.path;
const PROBE = `${TIER1_DIR}sync-probe.ts`;
const REMOVED = Object.keys(forkBoundary().removedUpstreamPaths)[0]!;
const SHARED = "shared.ts";

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fork-sync-repo-"));
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.invalid");
  run("config", "user.name", "Test");
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

interface SyncFixture {
  dir: string;
  run: (...args: string[]) => string;
  base: string;
  tip: string;
  ours: string;
}

/**
 * A miniature sync: a shared base, an upstream branch that renames a name, touches a removed
 * file, reorders tokens, and adds a module, and a fork tip that edits the renamed file's line,
 * deletes the removed file plus an unrecorded one, and adds Tier-1 and stray files. With `clash`,
 * both sides also add the same Tier-1 path with different content (an add/add collision).
 */
function syncRepo(clash: boolean): SyncFixture {
  const dir = scratchRepo();
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  const write = (path: string, content: string) => {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  write(SHARED, `export const oldWidgetName = "old";\nexport const forkSetting = 1;\n` +
    `export const shared = oldWidgetName;\n`);
  write(REMOVED, "name: cla\non: push\n");
  write("unrelated.ts", "export const unrelated = 1;\n");
  write("shuffled.ts", "export const alphaToken = 1;\nexport const betaToken = 2;\n");
  run("add", ".");
  run("commit", "-q", "-m", "base");
  const base = run("rev-parse", "HEAD");

  run("checkout", "-q", "-b", "upstream");
  write(SHARED, `export const newWidgetName = "old";\nexport const forkSetting = 1;\n` +
    `export const shared = newWidgetName;\n`);
  run("commit", "-qam", "upstream: rename oldWidgetName");
  write(REMOVED, "name: cla\non: pull_request\n");
  run("commit", "-qam", "upstream: touch removed workflow");
  write("shuffled.ts", "export const betaToken = 2;\nexport const alphaToken = 1;\n");
  write("src/upstreamwidget.ts", "export const upstreamwidget = 1;\n");
  if (clash) write(`${TIER1_DIR}clash.ts`, `export const clashMarker = "upstream";\n`);
  run("add", ".");
  run("commit", "-q", "-m", "upstream: shuffle and add");
  const tip = run("rev-parse", "upstream");

  run("checkout", "-q", "main");
  write(SHARED, `export const oldWidgetName = "fork-old";\nexport const forkSetting = 1;\n` +
    `export const shared = oldWidgetName;\n`);
  run("rm", "-q", REMOVED, "unrelated.ts");
  write(PROBE, "// Tier-1 probe for the sync tests.\n" +
    `import { upstreamwidget } from "upstreamwidget";\n` +
    "export const probe = oldWidgetName;\n" +
    "export const widget = upstreamwidget;\n" +
    `export const note = "shuffled mentions alone are not references";\n`);
  write("src/stray.ts", "export const stray = 1;\n");
  if (clash) write(`${TIER1_DIR}clash.ts`, `export const clashMarker = "fork";\n`);
  run("add", ".");
  run("commit", "-q", "-m", "fork work");
  const ours = run("rev-parse", "HEAD");
  return { dir, run, base, tip, ours };
}

test("fork changes split into Tier 2, undeclared adds, and unrecorded deletions", () => {
  const { dir, base, ours, tip } = syncRepo(true);
  try {
    inRepo(dir, () => {
      assert.deepEqual(forkTouchedFiles(base, ours, tip), {
        tier2: [SHARED],
        undeclaredAdds: ["src/stray.ts"],
        unrecordedDeletions: ["unrelated.ts"],
      });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("removed identifiers are net removals: renames fire, moves do not", () => {
  const { dir, base, tip } = syncRepo(false);
  try {
    inRepo(dir, () => {
      // Exactly the rename: the reordered tokens net to zero, short tokens stay out, and added
      // tokens are never candidates.
      assert.deepEqual(removedIdentifiers(base, tip), ["oldWidgetName"]);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("survivors are found at a ref and in the worktree", () => {
  const { dir, base, tip } = syncRepo(false);
  try {
    inRepo(dir, () => {
      const tokens = removedIdentifiers(base, tip);
      const expected = [{ token: "oldWidgetName", files: [PROBE, SHARED].toSorted() }];
      assert.deepEqual(findSurvivors(tokens, [TIER1_DIR, SHARED], "main"), expected);
      assert.deepEqual(findSurvivors(tokens, [TIER1_DIR, SHARED]), expected);
      assert.deepEqual(findSurvivors([], [TIER1_DIR], "main"), []);
      assert.deepEqual(findSurvivors(tokens, [], "main"), []);
      assert.throws(() => findSurvivors(tokens, [SHARED], "refs/heads/no-such-branch"),
        /cannot read refs\/heads\/no-such-branch/);
      assert.deepEqual(attributeRemoval("oldWidgetName", base, tip).length, 1);
      assert.match(attributeRemoval("oldWidgetName", base, tip)[0]!, /rename oldWidgetName/);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the impact plan scopes upstream to what the fork touches", () => {
  const { dir, base, ours, tip } = syncRepo(false);
  try {
    inRepo(dir, () => {
      const plan = planSync(base, tip, ours);
      assert.deepEqual(plan.commits.map(line => line.replace(/^[0-9a-f]+ /, "")), [
        "upstream: shuffle and add",
        "upstream: touch removed workflow",
        "upstream: rename oldWidgetName",
      ]);
      assert.deepEqual(plan.reconcile, [SHARED]);
      assert.equal(plan.removedTouched.length, 1);
      assert.equal(plan.removedTouched[0]!.path, REMOVED);
      assert.match(plan.removedTouched[0]!.commit, /touch removed workflow/);
      assert.deepEqual(plan.tier1References, [{
        changedFile: "src/upstreamwidget.ts",
        keyword: "upstreamwidget",
        referencing: [PROBE],
      }]);
      assert.deepEqual(findTier1References(["src/ix.ts", "src/shared.ts"], ours), [],
        "short and stoplisted stems are not worth the grep");
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("import references attribute unambiguous stems only", () => {
  const dir = scratchRepo();
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  const probe = `${TIER1_DIR}amb-probe.ts`;
  try {
    const file = join(dir, probe);
    mkdirSync(dirname(file), { recursive: true });
    // Specifiers need not resolve: matching is textual on the last segment.
    writeFileSync(file, `import { dup } from "dupmod";\nimport { solo } from "solomod";\n`);
    run("add", ".");
    run("commit", "-q", "-m", "base");
    inRepo(dir, () => {
      assert.deepEqual(
        findTier1References(["a/dupmod.ts", "b/dupmod.ts", "c/solomod.ts"], "HEAD"),
        [{ changedFile: "c/solomod.ts", keyword: "solomod", referencing: [probe] }]);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("merge policy keeps removals deleted and stops on Tier 2 and Tier-1 collisions", () => {
  const { dir, run } = syncRepo(true);
  const clashPath = `${TIER1_DIR}clash.ts`;
  try {
    try {
      run("merge", "--no-commit", "--no-ff", "upstream");
    } catch { /* conflicts stop the merge; that is the fixture working */ }
    inRepo(dir, () => {
      assert.equal(mergeHeadPresent(), true);
      const policy = applyMergePolicy();
      assert.deepEqual(policy.autoResolved, [REMOVED]);
      assert.deepEqual(
        policy.needsHuman.toSorted((a, b) => a.path < b.path ? -1 : 1),
        [
          { path: clashPath, tier: "Tier 1 (collision)" },
          { path: SHARED, tier: "Tier 2" },
        ].toSorted((a, b) => a.path < b.path ? -1 : 1));
      assert.deepEqual(unmergedPaths(), [clashPath, SHARED].toSorted());
      const msg = readFileSync(join(dir, ".git", "MERGE_MSG"), "utf8");
      assert.match(msg, /kept deleted/);
      assert.ok(msg.includes(REMOVED));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verify context follows in-progress, committed, and preview merges", () => {
  const { dir, run, base, tip, ours } = syncRepo(false);
  try {
    try {
      run("merge", "--no-commit", "--no-ff", "upstream");
    } catch { /* conflicts stop the merge; that is the fixture working */ }
    inRepo(dir, () => {
      assert.throws(() => resolveVerifyContext("upstream"), /resolve the remaining conflicts/);
    });
    run("checkout", "--theirs", "--", SHARED);
    run("rm", "-q", "--", REMOVED);
    run("add", "-A");
    inRepo(dir, () => {
      const ctx = resolveVerifyContext("upstream")!;
      assert.equal(ctx.mode, "in-progress");
      assert.equal(ctx.grepRef, undefined);
      assert.equal(ctx.base, base);
      assert.equal(ctx.oursRef, ours);
      assert.equal(ctx.upstreamTip, tip);
      assert.equal(ctx.auditUpstream, "upstream");
    });
    run("commit", "-q", "--no-edit");
    inRepo(dir, () => {
      const ctx = resolveVerifyContext("upstream")!;
      assert.equal(ctx.mode, "committed");
      assert.equal(ctx.grepRef, "HEAD");
      assert.equal(ctx.upstreamTip, tip);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verify context previews against upstream and refuses without one", () => {
  const { dir, base } = syncRepo(false);
  try {
    inRepo(dir, () => {
      const ctx = resolveVerifyContext("upstream")!;
      assert.equal(ctx.mode, "preview");
      assert.equal(ctx.base, base);
      assert.equal(ctx.grepRef, "HEAD");
      assert.equal(resolveVerifyContext("main"), null);
      assert.throws(() => resolveVerifyContext(), /no upstream ref/);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("preflight refuses dirty trees, bad refs, and repeats", () => {
  const { dir, base } = syncRepo(false);
  try {
    writeFileSync(join(dir, SHARED), "dirty\n");
    inRepo(dir, () => {
      assert.throws(() => preflightStart("upstream"), UsageError);
      assert.throws(() => preflightStart("upstream"), /commit or stash/);
    });
    execFileSync("git", ["-C", dir, "checkout", "--", SHARED]);
    inRepo(dir, () => {
      assert.throws(() => preflightStart("refs/heads/nope"), /does not resolve/);
      assert.equal(preflightStart("main"), null);
      assert.deepEqual(preflightStart("upstream"), { tip: "upstream", base });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verification gates pin their commands", () => {
  const vp = fileURLToPath(new URL("../vp/run.ts", import.meta.url));
  const audit = fileURLToPath(new URL("./upstream-merge-audit.ts", import.meta.url));
  assert.deepEqual(typecheckPlan("/repo"), [
    { cmd: "pnpm", args: ["types:scripts"], cwd: "/repo" },
    { cmd: process.execPath,
      args: [vp, "--filter=!cloudflare-os", "--no-cache", "build"], cwd: "/repo" },
  ]);
  assert.deepEqual(auditCommand("/repo", "foundation/main"), {
    cmd: process.execPath, args: [audit, "--upstream", "foundation/main"], cwd: "/repo",
  });
});

const SYNC_CLI = fileURLToPath(new URL("./sync-upstream.ts", import.meta.url));

/** Runs the CLI in `dir`, returning its exit status and captured stdout. */
function runSyncOut(dir: string, ...args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("node", [SYNC_CLI, ...args],
      { cwd: dir, encoding: "utf8", stdio: "pipe" });
    return { status: 0, stdout };
  } catch (error) {
    const { status, stdout } = error as { status?: number; stdout?: string };
    return { status: status ?? -1, stdout: stdout ?? "" };
  }
}

/** Runs the CLI in `dir` and returns its exit status. */
function runSync(dir: string, ...args: string[]): number {
  return runSyncOut(dir, ...args).status;
}

test("a sync runs end to end: impact, merge, policy, resolve, green verify", () => {
  const { dir, run } = syncRepo(false);
  try {
    assert.equal(runSync(dir, "--upstream", "upstream", "--branch", "sync/test"), 1);
    assert.equal(run("branch", "--show-current"), "sync/test");
    assert.ok(readFileSync(join(dir, ".git", "MERGE_MSG"), "utf8").includes(REMOVED));
    // Resolve: upstream's side for Tier 2, and rename the Tier-1 survivor.
    run("checkout", "--theirs", "--", SHARED);
    const probe = join(dir, PROBE);
    writeFileSync(probe, readFileSync(probe, "utf8").replaceAll("oldWidgetName", "newWidgetName"));
    run("add", "-A");
    assert.equal(runSync(dir, "--verify", "--upstream", "upstream", "--skip-typecheck"), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compound names are multi-segment identifiers, never prose or hex", () => {
  for (const token of ["prohibitAllSharing", "AdminConfig", "addModel", "abort_event", "$store", "id2000"]) {
    assert.equal(isCompoundName(token), true, token);
  }
  for (const token of ["Likewise", "Returns", "Catalog", "Unicode", "Called", "e2f1707", "0x1A4f"]) {
    assert.equal(isCompoundName(token), false, token);
  }
  assert.equal(isCompoundName("deadBEEF"), true, "hex letters in a name do not make it a hash");
  // Shape-true (digits), but the tip-count cap drops colors and hashes that survive upstream.
  assert.equal(isCompoundName("b84e00"), true);
});

test("surviving tokens are compound names nearly gone from the tip", () => {
  const dir = scratchRepo();
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  try {
    const aliveBase = `export const compoundAlive = [${
      Array(11).fill("compoundAlive").join(", ")}];\n`;
    writeFileSync(join(dir, "words.ts"),
      "export const compoundGone = 1;\n" +
      "export const compoundRare = 2;\n" +
      "export const compoundRareUse = compoundRare;\n" +
      "// compoundRare configured.\n" +
      aliveBase +
      "export const solitude = 4;\n");
    run("add", ".");
    run("commit", "-q", "-m", "base");
    const base = run("rev-parse", "HEAD");
    run("checkout", "-q", "-b", "upstream");
    writeFileSync(join(dir, "words.ts"),
      "// compoundRare noted here, and compoundRare again.\n" +
      `// ${Array(10).fill("compoundAlive").join(" ")}\n` +
      "export const kept = 5;\n");
    run("commit", "-qam", "upstream removes the names");
    const tip = run("rev-parse", "upstream");
    inRepo(dir, () => {
      // compoundAlive is net-removed but still said ten times: alive, not a survivor.
      // solitude is gone everywhere but single-word: prose-shaped, the typecheck owns it.
      assert.deepEqual(survivingTokens(base, tip), [
        { token: "compoundGone", tipCount: 0 },
        { token: "compoundRareUse", tipCount: 0 },
        { token: "compoundRare", tipCount: 2 },
      ]);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a sync behind upstream previews the pending range instead", () => {
  const { dir, run, tip } = syncRepo(false);
  try {
    try {
      run("merge", "--no-commit", "--no-ff", "upstream");
    } catch { /* conflicts stop the merge; that is the fixture working */ }
    run("checkout", "--theirs", "--", SHARED);
    run("rm", "-q", "--", REMOVED);
    run("add", "-A");
    run("commit", "-q", "--no-edit");
    run("checkout", "-q", "upstream");
    run("commit", "-q", "--allow-empty", "-m", "upstream moves on");
    run("checkout", "-q", "main");
    inRepo(dir, () => {
      const ctx = resolveVerifyContext("upstream")!;
      assert.equal(ctx.mode, "preview");
      assert.equal(ctx.upstreamTip, "upstream");
      assert.equal(ctx.base, tip);
      assert.ok(ctx.staleSync?.includes("merge commit"));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stale preview names the sync it supersedes", () => {
  const { dir, run } = syncRepo(false);
  try {
    try {
      run("merge", "--no-commit", "--no-ff", "upstream");
    } catch { /* conflicts stop the merge; that is the fixture working */ }
    run("checkout", "--theirs", "--", SHARED);
    run("rm", "-q", "--", REMOVED);
    // Rename the Tier-1 survivor too, so the preview has nothing to report.
    const probe = join(dir, PROBE);
    writeFileSync(probe, readFileSync(probe, "utf8").replaceAll("oldWidgetName", "newWidgetName"));
    run("add", "-A");
    run("commit", "-q", "--no-edit");
    run("checkout", "-q", "upstream");
    run("commit", "-q", "--allow-empty", "-m", "upstream moves on");
    run("checkout", "-q", "main");
    const { status, stdout } = runSyncOut(dir, "--verify", "--upstream", "upstream", "--skip-typecheck");
    assert.equal(status, 0);
    assert.match(stdout, /behind upstream; previewing the pending range/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a dry run plans without branching or merging", () => {
  const { dir, run } = syncRepo(false);
  try {
    assert.equal(runSync(dir, "--dry-run", "--upstream", "upstream"), 0);
    assert.equal(run("branch", "--show-current"), "main");
    assert.equal(run("branch", "--list", "sync/*"), "");
    inRepo(dir, () => assert.equal(mergeHeadPresent(), false));
    assert.equal(runSync(dir, "--dry-run", "--verify", "--upstream", "upstream"), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a re-run mid-merge reports what is left", () => {
  const { dir, run } = syncRepo(false);
  try {
    assert.equal(runSync(dir, "--upstream", "upstream", "--branch", "sync/test"), 1);
    assert.equal(runSync(dir, "--upstream", "upstream", "--branch", "sync/test"), 1,
      "re-entry must not re-resolve or fail: it reports the remaining conflicts");
    run("checkout", "--theirs", "--", SHARED);
    run("add", "-A");
    assert.equal(runSync(dir, "--upstream", "upstream", "--branch", "sync/test"), 0,
      "with nothing left, re-entry points at --verify");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
