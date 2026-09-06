import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import capnwebValidate from 'capnweb-validate/vite'

/**
 * Tests run inside workerd (via vitest-pool-workers) so they exercise the same runtime APIs as
 * production -- e.g. Uint8Array.toHex/fromHex and crypto.subtle used by the sharing module. Most
 * tests import modules directly; the test-only main re-exports the production Worker and adds a
 * persistable account serviceFetcher and cleanup barriers for the User lifecycle tests. SQLite
 * bindings also support the existing Overseer tests without the full deployment configuration.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: './__tests__/fork-fixtures/openapi-account-worker.ts',
      miniflare: {
        compatibilityDate: '2026-02-02',
        compatibilityFlags: ['experimental', 'nodejs_compat', 'allow_irrevocable_stub_storage'],
        durableObjects: {
          TEST_OVERSEER: { className: 'OverseerDurableObject', useSQLite: true },
          TEST_USER: { className: 'UserDurableObject', useSQLite: true },
          TEST_OPENAPI_ACCOUNT_CONTROL: { className: 'OpenApiAccountTestControl', useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ['__tests__/*.test.ts'],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ['../../scripts/assert-workerd.ts'],
  },
})
