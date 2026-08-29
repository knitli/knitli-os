import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

const EXPECTED_OPEN_ERROR_CODES = new Set([
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_ACCESS_DENIED",
  "AI_EXECUTOR_ADMIN_FEATURE_UNAVAILABLE",
  "AI_EXECUTOR_ADMIN_PROTOCOL_MISMATCH",
  "AI_EXECUTOR_PROFILE_REVISION_CONFLICT",
  "AI_EXECUTOR_ADMIN_SERVICE_UNAVAILABLE",
]);

const EXPECTED_AI_BRIDGE_FAKE_ERRORS = new Set([
  "upstream revision details",
  "SENTINEL_PROVIDER_SECRET in message",
]);

export default defineConfig({
  esbuild: {
    target: "es2022",
  },
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/server.ts",
      remoteBindings: false,
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          ADMINS: ["aibridgeadmin"],
        },
        serviceBindings: {
          AI_INFERENCE_ADMIN: {
            name: "fake-inference-admin",
            entrypoint: "InferenceAdmin",
          },
          AI_INFERENCE_ADMIN_CONTROL: {
            name: "fake-inference-admin",
            entrypoint: "InferenceAdmin",
          },
        },
        workers: [{
          name: "fake-inference-admin",
          modules: true,
          compatibilityDate: "2026-02-02",
          script: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            const profile = {
              id: "0198ddb0-7ac5-7ee9-8e65-62da80270035",
              label: "Bedrock Sonnet",
              provider: "aws-bedrock",
              model: "anthropic.claude-sonnet-4-20250514-v1:0",
              maxInputBytes: 131072,
              maxOutputTokens: 4096,
              timeoutMs: 30000,
              requestsPerMinute: 12,
              lifecycle: "draft",
              revision: 1,
            };

            let protocolVersion = 1;
            let failure = "none";
            let calls = [];

            function maybeFail() {
              if (failure === "conflict") {
                const error = new Error("upstream revision details");
                error.name = "CatalogConflictError";
                throw error;
              }
              if (failure === "service") {
                const cause = new Error("SENTINEL_PROVIDER_SECRET in cause");
                const error = new Error("SENTINEL_PROVIDER_SECRET in message", { cause });
                error.stack = "SENTINEL_PROVIDER_SECRET in stack";
                throw error;
              }
            }

            export class InferenceAdmin extends WorkerEntrypoint {
              get protocolVersion() {
                calls.push({ method: "protocolVersion", args: [] });
                return protocolVersion;
              }

              async listProfiles() {
                calls.push({ method: "listProfiles", args: [] });
                maybeFail();
                return [profile];
              }

              async createProfile(input) {
                calls.push({ method: "createProfile", args: [input] });
                maybeFail();
                return { ...input, id: profile.id, lifecycle: "draft", revision: 1 };
              }

              async updateProfile(id, input, revision) {
                calls.push({ method: "updateProfile", args: [id, input, revision] });
                maybeFail();
                return { ...input, id, lifecycle: "draft", revision: revision + 1 };
              }

              async verifyProfile(id, revision) {
                calls.push({ method: "verifyProfile", args: [id, revision] });
                maybeFail();
                return { ...profile, id, lifecycle: "verified", revision: revision + 1 };
              }

              async activateProfile(id, revision) {
                calls.push({ method: "activateProfile", args: [id, revision] });
                maybeFail();
                return { ...profile, id, lifecycle: "active", revision: revision + 1 };
              }

              async disableProfile(id, revision) {
                calls.push({ method: "disableProfile", args: [id, revision] });
                maybeFail();
                return { ...profile, id, lifecycle: "disabled", revision: revision + 1 };
              }

              async reset() {
                protocolVersion = 1;
                failure = "none";
                calls = [];
              }

              async setProtocolVersion(value) {
                protocolVersion = value;
              }

              async setFailure(value) {
                failure = value;
              }

              async getCalls() {
                return calls;
              }
            }
          `,
        }],
      },
    }),
  ],
  test: {
    include: ["__integration__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["../../scripts/assert-workerd.ts"],
    // Whichever test runs first pays for workerd booting and instantiating the whole backend
    // bundle -- ~6s on a dev machine and roughly 3x that on a CI runner, while every subsequent
    // test in the file finishes in tens of milliseconds. The timeout has to clear that cold
    // start, not the steady-state cost, or the first test fails wherever the runner is slow.
    testTimeout: 60_000,
    // Fix for failing tests in Gateway AI executor
    hookTimeout: 70_000,
    // A rejected future capability is reported independently from the awaited pipelined call.
    // The tests assert these exact rejections; all unrelated unhandled errors remain fatal.
    onUnhandledError(error) {
      const code = "code" in error ? error.code : undefined;
      if (typeof code === "string" && EXPECTED_OPEN_ERROR_CODES.has(code)) return false;
      if (EXPECTED_AI_BRIDGE_FAKE_ERRORS.has(error.message)) return false;
      // The reset-recovery tests abort every Durable Object mid-session; capabilities that were
      // held across the abort (e.g. the fire-and-forget AdminSettings install kicked off by the
      // fetch handler) reject on their own schedule, independent of any awaited call.
      if (error.message?.includes("abortAllDurableObjects")) return false;
      // Same, for the test that aborts only the user DO (state.abort with this reason).
      if (error.message?.includes("user-DO reset injected by test")) return false;
    },
  },
});
