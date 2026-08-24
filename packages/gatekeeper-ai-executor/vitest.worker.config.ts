import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        durableObjects: {
          AI_EXECUTOR_GATEKEEPER: {
            className: "AiExecutorGatekeeperImpl",
            useSQLite: true,
          },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
        serviceBindings: {
          AI_INFERENCE_RUNTIME: {
            name: kCurrentWorker,
            entrypoint: "FakeInferenceRuntime",
          },
          RUNTIME_CONTROL: {
            name: kCurrentWorker,
            entrypoint: "FakeInferenceRuntime",
          },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
