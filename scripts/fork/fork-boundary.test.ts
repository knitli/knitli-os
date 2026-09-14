import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { forkBoundary, parseForkBoundary } from "./fork-boundary.ts";

test("the live boundary loads and every entry records why", () => {
  const boundary = forkBoundary();
  assert.ok(boundary.forkOwned.length > 0, "Tier 1 should not be silently emptied");
  const seen = new Set<string>();
  for (const entry of boundary.forkOwned) {
    assert.ok(!seen.has(entry.path), `duplicate Tier-1 entry: ${entry.path}`);
    seen.add(entry.path);
    // The reason is the whole point: a bare list rots into "why is this here?" within a sync or two.
    assert.ok(entry.reason.length > 30,
      `${entry.path} needs a reason someone can act on, got: ${entry.reason}`);
  }
  const removed = Object.entries(boundary.removedUpstreamPaths);
  assert.ok(removed.length > 0, "the removed list should not be silently emptied");
  for (const [path, reason] of removed) {
    assert.ok(reason.length > 30, `${path} needs a reason someone can act on, got: ${reason}`);
  }
});

test("the loader and the parser agree on the live config", () => {
  const text = readFileSync(new URL("./fork-boundary.json", import.meta.url), "utf8");
  assert.deepEqual(parseForkBoundary(text), forkBoundary());
  assert.equal(forkBoundary(), forkBoundary(), "the boundary loads once");
});

function validBoundary(): Record<string, unknown> {
  return {
    forkOwned: [{ path: "packages/a-feature/", reason: "Upstream has no such tree." }],
    removedUpstreamPaths: { "some/removed.yml": "Only ever fails here." },
    formatExceptions: [],
  };
}

test("a minimal valid boundary parses", () => {
  const boundary = parseForkBoundary(JSON.stringify(validBoundary()));
  assert.deepEqual(boundary.forkOwned, [
    { path: "packages/a-feature/", reason: "Upstream has no such tree." },
  ]);
  assert.deepEqual(boundary.removedUpstreamPaths, { "some/removed.yml": "Only ever fails here." });
  assert.deepEqual(boundary.formatExceptions, []);
});

for (const [name, mutate, pattern] of [
  ["unknown top-level key", (b: Record<string, unknown>) => {
    b["forkowned"] = b["forkOwned"];
    delete b["forkOwned"];
  }, /unknown key "forkowned"/],
  ["missing Tier 1", (b: Record<string, unknown>) => {
    delete b["forkOwned"];
  }, /forkOwned must be a non-empty array/],
  ["emptied Tier 1", (b: Record<string, unknown>) => {
    b["forkOwned"] = [];
  }, /forkOwned must be a non-empty array/],
  ["Tier-1 entry must be an object", (b: Record<string, unknown>) => {
    b["forkOwned"] = ["packages/a-feature/"];
  }, /forkOwned\[0\] must be an object/],
  ["Tier-1 entry rejects unknown keys", (b: Record<string, unknown>) => {
    b["forkOwned"] = [{ path: "packages/a-feature/", reason: "x", since: "today" }];
  }, /forkOwned\[0\]: unknown key "since"/],
  ["Tier-1 path must be a path, not a bare name", (b: Record<string, unknown>) => {
    b["forkOwned"] = [{ path: "a-feature", reason: "Upstream has no such tree." }];
  }, /forkOwned\[0\]\.path must name a directory or file path/],
  ["Tier-1 entry needs a reason", (b: Record<string, unknown>) => {
    b["forkOwned"] = [{ path: "packages/a-feature/", reason: "" }];
  }, /forkOwned\[0\]\.reason needs a reason/],
  ["removed paths must be an object", (b: Record<string, unknown>) => {
    b["removedUpstreamPaths"] = [];
  }, /removedUpstreamPaths must be an object/],
  ["removed path must be a path", (b: Record<string, unknown>) => {
    b["removedUpstreamPaths"] = { "removed.yml": "Only ever fails here." };
  }, /must name a directory or file path/],
  ["removed path needs a reason", (b: Record<string, unknown>) => {
    b["removedUpstreamPaths"] = { "some/removed.yml": "" };
  }, /needs a reason someone can act on/],
  ["exceptions must be an array", (b: Record<string, unknown>) => {
    b["formatExceptions"] = {};
  }, /formatExceptions must be an array/],
  ["exception blob ids must be full SHAs", (b: Record<string, unknown>) => {
    b["formatExceptions"] = [{
      path: "src/a.ts",
      upstreamBlob: "abc123",
      forkBlob: "0".repeat(40),
      reason: "Reviewed.",
    }];
  }, /upstreamBlob must be a full 40-hex blob id/],
] as const) {
  test(`malformed boundary is rejected: ${name}`, () => {
    const boundary = validBoundary();
    mutate(boundary);
    assert.throws(() => parseForkBoundary(JSON.stringify(boundary)), pattern);
  });
}

test("malformed JSON names itself", () => {
  assert.throws(() => parseForkBoundary("{oops"), /not valid JSON/);
  assert.throws(() => parseForkBoundary("[]"), /must be an object at the top level/);
});
