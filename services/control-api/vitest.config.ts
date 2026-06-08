import { defineConfig } from 'vitest/config';

// Default config runs only unit tests (no real DB / Redis required).
// Integration tests live in vitest.integration.config.ts and need the
// e2e:bootstrap docker stack.
export default defineConfig({
  test: {
    // Run all test files in a single worker to prevent parallel DB collisions.
    // Hackathon tests insert rows with is_active=true, which hits the
    // hackathons_only_one_active unique partial index. singleFork serialises
    // all spec files so only one is running against the shared control DB at
    // a time.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Integration tests — require live Postgres / Redis. Run via `npm run test:integration`.
      'src/__tests__/auto-api.test.ts',
      'src/__tests__/fn-gateway.test.ts',
      'src/__tests__/health.test.ts',
      'src/__tests__/init.test.ts',
      'src/__tests__/mcp-route.test.ts',
      'src/__tests__/partner-pools-admin.test.ts',
      'src/__tests__/partner-proxy-forwarder.test.ts',
      'src/__tests__/partner-proxy-pool.test.ts',
      'src/__tests__/partner-proxy-route.test.ts',
      'src/__tests__/rls-routes.test.ts',
      'src/__tests__/rls-validator.test.ts',
      'src/__tests__/runtime-db-smoke.test.ts',
      'src/__tests__/schema.test.ts',
      'src/routes/storage.test.ts',
      'src/services/fork-count-sweeper.test.ts',
      'src/services/kv/kv-scope.test.ts',
    ],
  },
});
