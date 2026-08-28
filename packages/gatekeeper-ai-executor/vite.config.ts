import capnwebValidate from "capnweb-validate/vite";
import gatekeeperConfiguratorConfig from "../../scripts/gatekeeper-configurator-vite-config.js";
import { withVitestTask } from "../../scripts/vitest-task-vite-config.js";

const config = {
  ...gatekeeperConfiguratorConfig,
  plugins: [capnwebValidate()],
  test: {
    environment: "node",
    include: ["__tests__/*.test.ts"],
  },
};

export default withVitestTask(config, [
  "vitest run --config vite.config.ts",
  "vitest run --config vitest.worker.config.ts",
]);
