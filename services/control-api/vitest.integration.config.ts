import { defineConfig } from 'vitest/config';

// Integration tests — require the e2e:bootstrap docker stack
// (control-plane-db, data-plane-db, runtime-plane-db, redis, localstack).
// Run with `npm run test:integration` from this workspace, or
// `npm run e2e:bootstrap && npm run test:integration` from the repo root.
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    include: [
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
