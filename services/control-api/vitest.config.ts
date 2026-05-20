import { defineConfig } from 'vitest/config';

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
  },
});
