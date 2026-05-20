import { defineConfig } from 'vitest/config';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.e2e' });

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallel: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
