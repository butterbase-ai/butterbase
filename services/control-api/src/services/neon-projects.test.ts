import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getDataProjectIdForRegion,
  getRuntimeProjectIdForRegion,
  assertNeonProjectsConfig,
  __resetNeonProjectsCache,
} from './neon-projects.js';

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...SAVED_ENV };
  __resetNeonProjectsCache();
});
afterEach(() => {
  process.env = { ...SAVED_ENV };
  __resetNeonProjectsCache();
});

describe('getDataProjectIdForRegion', () => {
  it('reads NEON_DATA_PROJECT_ID_<REGION_UPPER_UNDERSCORED>', () => {
    process.env.NEON_DATA_PROJECT_ID_US_EAST_1 = 'proj-data-use1';
    expect(getDataProjectIdForRegion('us-east-1')).toBe('proj-data-use1');
  });

  it('falls back to legacy NEON_DATA_PROJECT_ID for region "local"', () => {
    process.env.NEON_DATA_PROJECT_ID = 'proj-data-legacy';
    expect(getDataProjectIdForRegion('local')).toBe('proj-data-legacy');
  });

  it('throws for an unconfigured region', () => {
    expect(() => getDataProjectIdForRegion('eu-west-1')).toThrow(/NEON_DATA_PROJECT_ID_EU_WEST_1/);
  });
});

describe('getRuntimeProjectIdForRegion', () => {
  it('reads NEON_RUNTIME_PROJECT_ID_<REGION_UPPER_UNDERSCORED>', () => {
    process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 = 'proj-runtime-use1';
    expect(getRuntimeProjectIdForRegion('us-east-1')).toBe('proj-runtime-use1');
  });
});

describe('assertNeonProjectsConfig', () => {
  it('passes when all configured regions have both project IDs', () => {
    process.env.BUTTERBASE_REGIONS = 'us-east-1,eu-west-1';
    process.env.NEON_DATA_PROJECT_ID_US_EAST_1 = 'd-use1';
    process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 = 'r-use1';
    process.env.NEON_DATA_PROJECT_ID_EU_WEST_1 = 'd-euw1';
    process.env.NEON_RUNTIME_PROJECT_ID_EU_WEST_1 = 'r-euw1';
    expect(() => assertNeonProjectsConfig()).not.toThrow();
  });

  it('throws when any region is missing a project ID', () => {
    process.env.BUTTERBASE_REGIONS = 'us-east-1,eu-west-1';
    process.env.NEON_DATA_PROJECT_ID_US_EAST_1 = 'd-use1';
    process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 = 'r-use1';
    process.env.NEON_DATA_PROJECT_ID_EU_WEST_1 = 'd-euw1';
    // missing NEON_RUNTIME_PROJECT_ID_EU_WEST_1
    expect(() => assertNeonProjectsConfig()).toThrow(/NEON_RUNTIME_PROJECT_ID_EU_WEST_1/);
  });
});
