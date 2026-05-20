import { describe, it, expect, afterEach } from 'vitest';
import { resolveRuntimeDbUrl, _resetRuntimeDbPools } from './runtime-db.js';

afterEach(() => {
  _resetRuntimeDbPools();
});

describe('resolveRuntimeDbUrl', () => {
  it('returns the URL for the requested region', () => {
    expect(
      resolveRuntimeDbUrl({
        urlsByRegion: { 'us-east-1': 'postgres://us', 'eu-west-1': 'postgres://eu' },
      }, 'eu-west-1')
    ).toEqual('postgres://eu');
  });

  it('throws when the region has no URL configured', () => {
    expect(() =>
      resolveRuntimeDbUrl({ urlsByRegion: { 'us-east-1': 'postgres://us' } }, 'eu-west-1')
    ).toThrow(/no runtime DB URL.*eu-west-1/i);
  });

  it('throws on empty URL', () => {
    expect(() =>
      resolveRuntimeDbUrl({ urlsByRegion: { 'us-east-1': '' } }, 'us-east-1')
    ).toThrow(/runtime DB URL.*empty/i);
  });
});
