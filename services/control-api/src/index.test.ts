import { describe, it, expect, afterEach, vi } from 'vitest';

// Minimum env needed for module-level guards to pass so that buildApp() is
// reachable, while each test controls the specific bypass flags under test.
// Prod-only module-level guards (AUTH_ENCRYPTION_KEY etc.) are satisfied so
// they don't call process.exit before our assertion in buildApp() fires.
const BASE_ENV: Record<string, string> = {
  BUTTERBASE_REGIONS: 'us-east-1',
  BUTTERBASE_REGION: 'us-east-1',
  NEON_RUNTIME_PROJECT_ID_US_EAST_1: 'postgresql://u:p@localhost/db',
  NEON_DATA_PROJECT_ID_US_EAST_1: 'postgresql://u:p@localhost/db',
  NEON_PLATFORM_PRIMARY_URL: 'postgresql://u:p@localhost/db',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  // Satisfy the existing module-level production secret checks so they don't
  // call process.exit before our assertion inside buildApp() fires.
  AUTH_ENCRYPTION_KEY: 'test-encryption-key-32-bytes-here',
  LOCAL_JWT_SECRET: 'test-jwt-secret',
  BUILD_RUNNER_SHARED_SECRET: 'test-runner-secret',
  BUILD_RUNNER_URL: 'https://build-runner.example.com',
  // Skip runtime-table-audit (no real DBs in unit tests)
  SKIP_RUNTIME_AUDIT: '1',
};

describe('assertE2EBypassesNotInProduction', () => {
  const orig = { ...process.env };

  afterEach(() => {
    process.env = { ...orig };
    vi.resetModules();
  });

  it('throws when BUTTERBASE_E2E=1 in production', async () => {
    process.env = {
      ...BASE_ENV,
      NODE_ENV: 'production',
      BUTTERBASE_E2E: '1',
    };
    const { buildApp } = await import('./index.js');
    await expect(buildApp()).rejects.toThrow(/BUTTERBASE_E2E.*production/i);
  });

  it('throws when KV_LOCAL_FILE set in production', async () => {
    process.env = {
      ...BASE_ENV,
      NODE_ENV: 'production',
      KV_LOCAL_FILE: '/tmp/anything.json',
    };
    const { buildApp } = await import('./index.js');
    await expect(buildApp()).rejects.toThrow(/KV_LOCAL_FILE.*production/i);
  });
});
