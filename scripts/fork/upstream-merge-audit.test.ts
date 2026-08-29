import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FORK_OWNED_PREFIXES,
  isForkOwned,
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
