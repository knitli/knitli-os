import capnwebValidate from "capnweb-validate/vite";
import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { withVitestTask } from "@gadgets/scripts/vitest-task";

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
