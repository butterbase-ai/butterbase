import { describe, it, expect } from 'vitest';
import { resolveRuntimeUrls, MigrationScopeError } from './migrate.js';

describe('resolveRuntimeUrls', () => {
  it('returns one URL per region from env', () => {
    expect(
      resolveRuntimeUrls(['us-east-1', 'eu-west-1'], {
        NEON_RUNTIME_PROJECT_ID_US_EAST_1: 'postgres://us',
        NEON_RUNTIME_PROJECT_ID_EU_WEST_1: 'postgres://eu',
      })
    ).toEqual({ 'us-east-1': 'postgres://us', 'eu-west-1': 'postgres://eu' });
  });

  it('throws when a region has no env var', () => {
    expect(() =>
      resolveRuntimeUrls(['us-east-1', 'eu-west-1'], {
        NEON_RUNTIME_PROJECT_ID_US_EAST_1: 'postgres://us',
      })
    ).toThrow(/NEON_RUNTIME_PROJECT_ID_EU_WEST_1/);
  });
});
