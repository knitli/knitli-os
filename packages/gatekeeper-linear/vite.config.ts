import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { withVitestTask } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ per-package settings: the shared gatekeeper-configurator tasks plus a two-pass `test` task,
 * pure logic in Node (upstream's `vitest.config.ts`) and the DO/RPC suite in workerd (fork,
 * `vitest.worker.config.ts`), composed the way gatekeeper-github does. `test` depends on
 * `build:configurator` because src/linear.ts imports the generated configurator HTML that the test
 * worker bundles; `build` also runs `tsconfig.test.json` so the tests type-check under CI.
 */
const config = withVitestTask(gatekeeperConfiguratorConfig, [
  "vitest run",
  "vitest run -c vitest.worker.config.ts",
]);

export default {
  ...config,
  run: {
    ...config.run,
    tasks: {
      ...config.run.tasks,
      build: { ...config.run.tasks.build, command: ["tsc", "tsc -p tsconfig.test.json"] },
      test: { ...config.run.tasks.test, dependsOn: ["build:configurator"] },
    },
  },
};
