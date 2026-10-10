// Vite+ per-package settings. The build:configurator task definition is shared by all gatekeepers
// with a configurator UI and ships as an export of `@gadgets/scripts`, alongside the builder it
// runs.
import { withTests } from '@gadgets/scripts/gatekeeper-configurator'

/** The shared configurator and test tasks, with the type check also covering `__tests__`. */
export default {
  ...withTests,
  run: {
    ...withTests.run,
    tasks: {
      ...withTests.run.tasks,
      build: { ...withTests.run.tasks.build, command: ["tsc", "tsc -p tsconfig.test.json"] },
    },
  },
};
