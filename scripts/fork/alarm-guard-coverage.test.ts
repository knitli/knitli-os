import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every Durable Object `alarm()` must be stoppable with the `ALARMS_DISABLED` kill switch (see
 * docs/alarm-audit.md): a runaway alarm has no hard spend cap behind it on Cloudflare, so the
 * emergency stop has to work everywhere, including handlers that arrive in an upstream sync.
 *
 * The body of each `async alarm(` method must itself call the alarm guard (`haltIfAlarmsDisabled`,
 * `guardedAlarm`, `guardedAlarmFor`, or `alarmsDisabled`), so a file with several handlers needs the
 * guard in each. Adding a handler without it fails here instead of shipping unstoppable.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = /\b(haltIfAlarmsDisabled|guardedAlarmFor|guardedAlarm|alarmsDisabled)\b/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "generated" || name === ".wrangler") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** The text from `async alarm(` through the brace that closes the method. */
function alarmBodies(text: string): string[] {
  const bodies: string[] = [];
  for (const match of text.matchAll(/\basync\s+alarm\s*\(/g)) {
    // Skip the parameter list, which may contain a type with braces, then match braces.
    let i = text.indexOf("{", text.indexOf(")", match.index));
    let depth = 0;
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) break;
    }
    bodies.push(text.slice(start, i + 1));
  }
  return bodies;
}

describe("Durable Object alarm kill switch", () => {
  it("finds a handler however it is spaced, and tells guarded from unguarded", () => {
    const unguarded = "class A {\n  async\n    alarm ()\n  : Promise<void> {\n    await go();\n  }\n}";
    const guarded = "class B {\n  async  alarm (\n  ) {\n    await haltIfAlarmsDisabled(this.ctx, this.env, \"b\");\n  }\n}";
    const bodies = alarmBodies(`${unguarded}\n${guarded}`);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies.map(body => GUARD.test(body)), [false, true]);
  });

  it("is called by every alarm() handler", () => {
    const packagesDir = join(repoRoot, "packages");
    const unguarded: string[] = [];
    let handlers = 0;
    for (const pkg of readdirSync(packagesDir)) {
      const src = join(packagesDir, pkg, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of sourceFiles(src)) {
        for (const body of alarmBodies(readFileSync(file, "utf8"))) {
          handlers++;
          if (!GUARD.test(body)) unguarded.push(file.slice(repoRoot.length + 1));
        }
      }
    }
    assert.ok(handlers >= 20, `found ${handlers} alarm() handlers; the scan is broken`);
    assert.deepEqual(
      unguarded, [],
      "alarm() without the ALARMS_DISABLED kill switch (use haltIfAlarmsDisabled/guardedAlarmFor from " +
        "@gadgets/observability/fork/alarm-guard, and add the handler to docs/alarm-audit.md)",
    );
  });
});
