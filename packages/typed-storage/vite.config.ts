// Vite+ per-package settings. The `test` task definition is shared by every package whose tests run
// under vitest and ships as `@gadgets/scripts/vitest-task`.
import { withVitestTask } from '@gadgets/scripts/vitest-task'

export default withVitestTask(
  {
    run: {
      tasks: {
        /**
         * `build` is a task rather than a package.json script so it can declare `output`, and this
         * is the one package where that is load-bearing rather than tidy: every other package is
         * `noEmit`, but this one's `exports` resolves to `dist/index.js`, so its consumers *read*
         * the build output instead of rebuilding it. `workshop-backend` and `gatekeeper-context`
         * type-check against `src` through a tsconfig `paths` entry, but wrangler bundles the real
         * `dist/index.js` -- which is why `workshop-backend`'s `build:integration-worker` and
         * `run-local.ts` both name `@gadgets/typed-storage#build` as an explicit prerequisite.
         *
         * `cache: false`: this task must never replay a cached `dist`. The fingerprint provably
         * ignores `src` changes (an entry built before `singleton` existed kept replaying its
         * stale `dist` over current sources, and appending a comment to `src/index.ts` still
         * reports a cache hit), so any caching here lets `dist` silently regress behind `src`
         * and breaks every consumer that bundles the real `dist/index.js` (notably the backend
         * unit suite under workerd). `tsc` on this tiny package costs seconds; correctness wins.
         * No `input`/`output`: those belong to the cached-task schema variant, which this task
         * no longer uses. Dependents (`build:integration-worker`, `run-local.ts`) still order
         * after this task via `dependsOn` and always see a freshly built `dist`.
         */
        build: {
          command: 'tsc',
          cache: false,
        },
      },
    },
  },
  'vitest run',
)
