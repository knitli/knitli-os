import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { withVitestTask } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ per-package settings: the shared gatekeeper-configurator tasks plus the workerd `test`
 * task, the same way gatekeeper-cloudflare and gatekeeper-github compose it. Just one project
 * here -- this package has no pure-logic tests to justify a separate Node pass alongside the
 * DO/RPC suite in workerd.
 */
export default withVitestTask(gatekeeperConfiguratorConfig, "vitest run -c vitest.worker.config.ts");
