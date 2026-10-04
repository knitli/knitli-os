// Fork-owned: the AI Executor gatekeeper is bound by the outer deployment rather than
// deployed as its own worker, but it keeps a wrangler.jsonc (generated from this file) for
// local dev, types, and tests like every other worker.
import { defineConfig } from "@cloudflare/config";
import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineConfig({
  worker: {
    name: "gatekeeper-ai-executor",
    entrypoint: ".wrangler/validate/src/ai-executor.ts",
    // Preserved from the hand-written wrangler.jsonc this replaces: bumping the compatibility
    // date changes runtime semantics, so this stays put until the executor needs newer behavior.
    compatibilityDate: "2026-02-02",
    compatibilityFlags: ["allow_irrevocable_stub_storage"],

    // No env bindings: the outer deployment binds the account DO and profiles at runtime.
    env: {},

    // Long-running model invocations need headroom above the default CPU limit.
    limits: { cpuMs: 300000 },
    placement: { mode: "smart" },

    observability: OBSERVABILITY,
  },
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: textModules(["**/*.txt"]),
} satisfies WranglerExtras;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["AiExecutorGatekeeperImpl"] },
];
