import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('region config wiring', () => {
  beforeEach(() => {
    vi.resetModules(); // force re-evaluation so cachedRegionConfig starts fresh
    delete process.env.BUTTERBASE_REGIONS;
    delete process.env.BUTTERBASE_REGION;
    delete process.env.NEON_REGION; // ensure we don't fall back to legacy default
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('throws when BUTTERBASE_REGIONS is missing', async () => {
    process.env.BUTTERBASE_REGION = 'us-east-1';
    const mod = await import('../config.js');
    expect(() => mod.assertRegionConfig()).toThrow(/BUTTERBASE_REGIONS/);
  });

  it('throws when BUTTERBASE_REGION is missing', async () => {
    process.env.BUTTERBASE_REGIONS = 'us-east-1';
    const mod = await import('../config.js');
    expect(() => mod.assertRegionConfig()).toThrow(/BUTTERBASE_REGION/);
  });

  it('returns region config when env is well-formed', async () => {
    process.env.BUTTERBASE_REGIONS = 'us-east-1,eu-west-1';
    process.env.BUTTERBASE_REGION = 'eu-west-1';
    const mod = await import('../config.js');
    const cfg = mod.assertRegionConfig();
    expect(cfg).toEqual({ regions: ['us-east-1', 'eu-west-1'], instanceRegion: 'eu-west-1' });
  });
});
