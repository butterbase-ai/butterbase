import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('runtime DB config', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.BUTTERBASE_REGIONS;
    delete process.env.BUTTERBASE_REGION;
    delete process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1;
    delete process.env.NEON_RUNTIME_PROJECT_ID_EU_WEST_1;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('builds a per-region runtime DB map from env vars', async () => {
    process.env.BUTTERBASE_REGIONS = 'us-east-1,eu-west-1';
    process.env.BUTTERBASE_REGION = 'us-east-1';
    process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 = 'postgres://us-runtime/db';
    process.env.NEON_RUNTIME_PROJECT_ID_EU_WEST_1 = 'postgres://eu-runtime/db';
    const mod = await import('../config.js');
    mod.assertRuntimeDbConfig();
    expect(mod.config.runtimeDb.urlsByRegion).toEqual({
      'us-east-1': 'postgres://us-runtime/db',
      'eu-west-1': 'postgres://eu-runtime/db',
    });
  });

  it('throws at startup when a runtime DB env var is missing for a region in BUTTERBASE_REGIONS', async () => {
    process.env.BUTTERBASE_REGIONS = 'us-east-1,eu-west-1';
    process.env.BUTTERBASE_REGION = 'us-east-1';
    process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 = 'postgres://us-runtime/db';
    const mod = await import('../config.js');
    expect(() => mod.assertRuntimeDbConfig()).toThrow(/NEON_RUNTIME_PROJECT_ID_EU_WEST_1/);
  });

  it('returns the URL for the local instance region via getLocalRuntimeUrl()', async () => {
    process.env.BUTTERBASE_REGIONS = 'us-east-1,eu-west-1';
    process.env.BUTTERBASE_REGION = 'eu-west-1';
    process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 = 'postgres://us/db';
    process.env.NEON_RUNTIME_PROJECT_ID_EU_WEST_1 = 'postgres://eu/db';
    const mod = await import('../config.js');
    mod.assertRuntimeDbConfig();
    expect(mod.getLocalRuntimeUrl()).toEqual('postgres://eu/db');
  });
});
