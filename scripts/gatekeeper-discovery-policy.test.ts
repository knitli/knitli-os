import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  isGatekeeperPackage,
  isStandaloneGatekeeperPackage,
} from "./gatekeeper-discovery-policy.ts";

test("AI Executor is first-class but requires outer deployment wiring", () => {
  assert.equal(isGatekeeperPackage("gatekeeper-ai-executor"), true);
  assert.equal(isStandaloneGatekeeperPackage("gatekeeper-ai-executor"), false);
  assert.equal(isStandaloneGatekeeperPackage("gatekeeper-github"), true);
  assert.equal(isStandaloneGatekeeperPackage("workshop-backend"), false);
});

test("dev discovery applies the standalone policy before launching gatekeepers", () => {
  const source = readFileSync(
    new URL("./run-dev-server.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /\.filter\(isStandaloneGatekeeperPackage\)/);
});
