import { withTests } from "@gadgets/scripts/gatekeeper-configurator";

/** The shared configurator and test tasks, with `build` also type-checking the tests. */
export default {
  ...withTests,
  run: {
    ...withTests.run,
    tasks: {
      ...withTests.run.tasks,
      build: {
        ...withTests.run.tasks.build,
        command: ["tsc", "tsc -p tsconfig.test.json"],
      },
      // The tests import the worker, which imports the generated configurator bundles, so a clean
      // checkout has to build them first.
      test: {
        ...withTests.run.tasks.test,
        dependsOn: ["build:configurator"],
      },
    },
  },
};
