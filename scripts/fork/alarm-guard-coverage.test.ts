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
 * The body of each `alarm(` method, `async` or not, must itself call the alarm guard (`haltIfAlarmsDisabled`,
 * `guardedAlarm`, `guardedAlarmFor`, or `alarmsDisabled`), so a file with several handlers needs the
 * guard in each. Adding a handler without it fails here instead of shipping unstoppable.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A call, not a mention: comments and string literals are blanked first (see `stripNonCode`).
const GUARD = /\b(haltIfAlarmsDisabled|guardedAlarmFor|guardedAlarm|alarmsDisabled)\s*\(/;

/**
 * Blanks comments and string/template literal contents, so a guard name in prose or a message
 * cannot satisfy the scan and a brace in a string cannot unbalance it. Template `${}` expressions
 * are blanked too, which is acceptable for an alarm body's guard call.
 */
function stripNonCode(text: string): string {
  return text.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
    match => match.replace(/[^\n]/g, " "),
  );
}

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

// A method definition `alarm(...)` with an optional return type, whether or not it is `async`
// (a handler may return `void`). A call (`this.alarm()`, `instance.alarm();`) is not followed by `{`.
const ALARM_METHOD = /(?<![.\w#$])alarm\s*\([^()]*\)\s*(?::[^{;=]+)?\{/g;

/** The text from the opening brace of each `alarm()` method through the brace that closes it. */
function alarmBodies(text: string): string[] {
  const bodies: string[] = [];
  for (const match of text.matchAll(ALARM_METHOD)) {
    const start = match.index + match[0].length - 1;
    let i = start;
    let depth = 0;
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
    const bodies = alarmBodies(stripNonCode(`${unguarded}\n${guarded}`));
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies.map(body => GUARD.test(body)), [false, true]);
  });

  it("finds a handler that is not async, and ignores calls to alarm()", () => {
    const source = [
      "class A { alarm(): void { this.ctx.storage.deleteAll(); } }",
      "class B { public override alarm(info?: AlarmInvocationInfo): Promise<void> { return go(); } }",
      "class C { async run() { await this.alarm(); instance.alarm(); if (alarm()) { go(); } } }",
    ].join("\n");
    const bodies = alarmBodies(stripNonCode(source));
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies.map(body => GUARD.test(body)), [false, false]);
  });

  it("does not accept a guard name that is only mentioned in a comment or string", () => {
    const mentioned = [
      "class A { async alarm() { // haltIfAlarmsDisabled(this.ctx, this.env, \"a\")\n await go(); } }",
      "class B { async alarm() { /* guardedAlarmFor( */ await go(); } }",
      "class C { async alarm() { log(\"haltIfAlarmsDisabled(\"); await go(); } }",
      "class D { async alarm() { const alarmsDisabled = true; await go(); } }",
    ];
    for (const source of mentioned) {
      const [body] = alarmBodies(stripNonCode(source));
      assert.ok(body && !GUARD.test(body), source);
    }
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
        for (const body of alarmBodies(stripNonCode(readFileSync(file, "utf8")))) {
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
