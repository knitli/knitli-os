import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TESTS_WITH_TIMEOUT_ENV, vitestTask } from "../vitest-task-vite-config.ts";

// Fork-owned regression for `TESTS_WITH_TIMEOUT_MAX_SECONDS` (docs/fork-maintenance.md), kept apart
// from upstream's `vitest-task.test.ts` so that file stays byte-identical. Like its siblings it runs
// from the repo root (`cwd: '..'` in `scripts/vite.config.ts`).
//
// Every case drives the real `with-timeout.ts`. The idle threshold is set far above any sleep so the
// wall-clock cap is the only watchdog that can fire, and each kill-or-survive case keeps a ~5x margin
// between the cap and the child's sleep rather than asserting a timing window. The rejection cases
// assert that the command never ran by what it would have left behind (a marker file, a live
// process), not by how long the run took.
const WITH_TIMEOUT = "scripts/with-timeout.ts";
const VAR = "TESTS_WITH_TIMEOUT_MAX_SECONDS";
const QUIET_FOR_1500_MS = "setTimeout(() => {}, 1500)";

/**
 * Runs the watchdog with `--max <flagMax>` over `script`, with `env` layered onto this process's.
 *
 * The watchdog leads its own process group (`detached`), and `pid` is that group's id: everything it
 * spawns stays in the group, even if the watchdog exits and orphans it. See `groupIsEmpty`.
 */
function run(
  flagMax: number, script: string, env: Record<string, string>,
): Promise<{ code: number | null; stderr: string; elapsedMs: number; pid: number }> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    // Neither switch is inherited: under `TESTS_WITH_TIMEOUT_DISABLE=1 vp run …` this suite itself
    // runs disabled, and under a CI that sets the override it runs overridden. The cases here set
    // exactly the variables they mean to.
    const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
    for (const name of ["TESTS_WITH_TIMEOUT_DISABLE", VAR]) if (!(name in env)) delete childEnv[name];
    const child = spawn(
      process.execPath,
      [WITH_TIMEOUT, "--idle", "30", "--max", String(flagMax), "--", "node", "-e", script],
      { stdio: ["ignore", "ignore", "pipe"], env: childEnv, detached: true });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolve({ code, stderr, elapsedMs: Date.now() - startedAt, pid: child.pid! }));
  });
}

/** True once no process is left in group `pgid`: signal 0 only probes, and ESRCH means none exist. */
function groupIsEmpty(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Kills whatever a case left in group `pgid`, so a regression cannot leak a process past the test. */
function killGroup(pgid: number): void {
  try { process.kill(-pgid, "SIGKILL"); } catch { /* already empty */ }
}

describe("TESTS_WITH_TIMEOUT_MAX_SECONDS", () => {
  it("leaves the --max given on the command line in force when unset", async () => {
    const { code, stderr } = await run(0.3, QUIET_FOR_1500_MS, {});
    assert.equal(code, 124);
    assert.match(stderr, /still running for 0\.3s/);
  });

  it("treats an empty value as unset", async () => {
    // A CI expression for an unset variable expands to "", which must not be read as "no limit".
    const { code } = await run(0.3, QUIET_FOR_1500_MS, { [VAR]: "" });
    assert.equal(code, 124);
  });

  it("replaces --max with a larger value, letting a slow run finish", async () => {
    const { code, elapsedMs } = await run(0.3, QUIET_FOR_1500_MS, { [VAR]: "30" });
    assert.equal(code, 0);
    assert.ok(elapsedMs >= 1400, `child finished after ${elapsedMs}ms, so it was cut short`);
  });

  it("replaces --max with a smaller value too, so what applies is the override", async () => {
    const { code, stderr } = await run(30, QUIET_FOR_1500_MS, { [VAR]: "0.3" });
    assert.equal(code, 124);
    // The message names the cap actually in force, so a log reader sees the real number.
    assert.match(stderr, /still running for 0\.3s/);
  });

  it("accepts the one-day ceiling", async () => {
    const { code } = await run(0.3, "", { [VAR]: "86400" });
    assert.equal(code, 0);
  });

  // Each of these must stop before the command starts, with a message naming the variable: an
  // override that failed quietly would leave the run on the 600s it was meant to get past, and the
  // first sign would be a kill.
  for (const [value, reason] of [
    ["abc", "is not a number"],
    ["0", "is zero"],
    ["-5", "is negative"],
    ["Infinity", "is not finite"],
    ["86401", "is past the one-day ceiling"],
  ] as const) {
    it(`rejects ${JSON.stringify(value)}, which ${reason}`, async t => {
      // Not a bound on `elapsedMs`: that spans `node` and type-stripping startup for the wrapper itself,
      // which a loaded 2-vCPU CI runner stretched past 2s while the wrapper never spawned anything.
      // A command that started has either written `marker` (its first act) or is still alive in the
      // wrapper's group: the wrapper can exit right after spawning it, before it has booted, so
      // `close` can resolve with no marker yet. Read the group first. Empty means the command already
      // exited, having written the marker before it did; the other order lets it finish between reads.
      const dir = mkdtempSync(join(tmpdir(), "with-timeout-"));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const marker = join(dir, "ran");
      const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`;
      const { code, stderr, pid } = await run(0.3, script, { [VAR]: value });
      t.after(() => killGroup(pid));
      assert.ok(groupIsEmpty(pid), "the command was still running after the wrapper exited");
      assert.equal(existsSync(marker), false, "the command started before the override was rejected");
      assert.equal(code, 2);
      assert.match(stderr, new RegExp(`^with-timeout: ${VAR} `, "m"));
    });
  }
});

describe("the override's env declaration", () => {
  // A cached `vp` task is handed only what it declares in `cache.env`, so a variable missing here
  // would be silently dropped from every cached run -- the failure mode
  // scripts/env-passthrough.test.ts documents. `vitest-task.test.ts` checks that each
  // hand-declared task spreads this list.
  it("is carried by the shared list and by every generated test task", () => {
    assert.ok(TESTS_WITH_TIMEOUT_ENV.includes(VAR));
    assert.ok(vitestTask("vitest run").cache.env.includes(VAR));
  });
});
