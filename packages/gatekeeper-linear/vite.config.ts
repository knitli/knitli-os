import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { vitestTask } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ per-package settings: the shared gatekeeper-configurator tasks plus the workerd `test`
 * task, the same way gatekeeper-google composes it. Just one project here -- this package has no
 * pure-logic tests to justify a separate Node pass alongside the DO/RPC suite in workerd.
 * `test` depends on `build:configurator` because src/linear.ts (:73-75) imports the generated
 * configurator HTML that the test worker bundles; `build` also runs `tsconfig.test.json` so the
 * tests themselves type-check under CI.
 */
export default {
  ...gatekeeperConfiguratorConfig,
  run: {
    ...gatekeeperConfiguratorConfig.run,
    tasks: {
      ...gatekeeperConfiguratorConfig.run.tasks,
      build: {
        ...gatekeeperConfiguratorConfig.run.tasks.build,
        command: ["tsc", "tsc -p tsconfig.test.json"],
      },
      test: {
        ...vitestTask("vitest run -c vitest.worker.config.ts"),
        dependsOn: ["build:configurator"],
      },
    },
  },
};
