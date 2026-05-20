import { describe, it, expect } from 'vitest';
import { parseRegions, parseInstanceRegion, loadRegionConfig, RegionConfigError } from './regions.js';

describe('parseRegions', () => {
  it('parses a comma-separated list, trimming whitespace', () => {
    expect(parseRegions('us-east-1, eu-west-1, ap-southeast-1')).toEqual([
      'us-east-1',
      'eu-west-1',
      'ap-southeast-1',
    ]);
  });

  it('parses a single-region list', () => {
    expect(parseRegions('us-east-1')).toEqual(['us-east-1']);
  });

  it('throws on empty input', () => {
    expect(() => parseRegions('')).toThrow(RegionConfigError);
    expect(() => parseRegions('   ')).toThrow(RegionConfigError);
  });

  it('throws on duplicate regions', () => {
    expect(() => parseRegions('us-east-1,us-east-1')).toThrow(/duplicate/i);
  });

  it('throws on invalid format', () => {
    expect(() => parseRegions('US_EAST_1')).toThrow(/lowercase/i);
    expect(() => parseRegions('us east 1')).toThrow();
  });
});

describe('parseInstanceRegion', () => {
  it('returns the region when present in the allowed list', () => {
    expect(parseInstanceRegion('us-east-1', ['us-east-1', 'eu-west-1'])).toEqual('us-east-1');
  });

  it('throws when region is not in the allowed list', () => {
    expect(() => parseInstanceRegion('eu-west-1', ['us-east-1'])).toThrow(/not in BUTTERBASE_REGIONS/);
  });

  it('throws on empty input', () => {
    expect(() => parseInstanceRegion('', ['us-east-1'])).toThrow(RegionConfigError);
  });
});

describe('loadRegionConfig', () => {
  it('returns regions and instanceRegion when env is well-formed', () => {
    const cfg = loadRegionConfig({
      BUTTERBASE_REGIONS: 'us-east-1,eu-west-1',
      BUTTERBASE_REGION: 'us-east-1',
    });
    expect(cfg).toEqual({ regions: ['us-east-1', 'eu-west-1'], instanceRegion: 'us-east-1' });
  });

  it('throws when BUTTERBASE_REGIONS is missing', () => {
    expect(() => loadRegionConfig({ BUTTERBASE_REGION: 'us-east-1' })).toThrow(/BUTTERBASE_REGIONS/);
  });

  it('throws when BUTTERBASE_REGION is missing', () => {
    expect(() => loadRegionConfig({ BUTTERBASE_REGIONS: 'us-east-1' })).toThrow(/BUTTERBASE_REGION/);
  });

  it('throws when instance region is not in the list', () => {
    expect(() =>
      loadRegionConfig({ BUTTERBASE_REGIONS: 'us-east-1', BUTTERBASE_REGION: 'eu-west-1' })
    ).toThrow(/not in BUTTERBASE_REGIONS/);
  });
});

describe('regionToEnvSuffix', () => {
  it('uppercases and replaces hyphens with underscores', async () => {
    const { regionToEnvSuffix } = await import('./regions.js');
    expect(regionToEnvSuffix('us-east-1')).toEqual('US_EAST_1');
    expect(regionToEnvSuffix('eu-west-1')).toEqual('EU_WEST_1');
  });
});

describe('parseFlyRegionMap', () => {
  it('parses a comma-separated map', async () => {
    const { parseFlyRegionMap } = await import('./regions.js');
    expect(parseFlyRegionMap('iad:us-east-1,lhr:eu-west-1')).toEqual({
      iad: 'us-east-1',
      lhr: 'eu-west-1',
    });
  });

  it('throws on malformed entry', async () => {
    const { parseFlyRegionMap, RegionConfigError } = await import('./regions.js');
    expect(() => parseFlyRegionMap('iad-us-east-1')).toThrow(RegionConfigError);
    expect(() => parseFlyRegionMap('iad:')).toThrow(RegionConfigError);
    expect(() => parseFlyRegionMap(':us-east-1')).toThrow(RegionConfigError);
  });

  it('throws on empty input', async () => {
    const { parseFlyRegionMap, RegionConfigError } = await import('./regions.js');
    expect(() => parseFlyRegionMap('')).toThrow(RegionConfigError);
  });

  it('throws on duplicate Fly region keys', async () => {
    const { parseFlyRegionMap } = await import('./regions.js');
    expect(() => parseFlyRegionMap('iad:us-east-1,iad:us-east-2')).toThrow(/duplicate/i);
  });
});

describe('loadRegionConfig with FLY_REGION derivation', () => {
  it('derives instanceRegion from FLY_REGION + BUTTERBASE_FLY_REGION_MAP when BUTTERBASE_REGION is unset', () => {
    const cfg = loadRegionConfig({
      BUTTERBASE_REGIONS: 'us-east-1,eu-west-1',
      BUTTERBASE_FLY_REGION_MAP: 'iad:us-east-1,lhr:eu-west-1',
      FLY_REGION: 'lhr',
    });
    expect(cfg.instanceRegion).toEqual('eu-west-1');
  });

  it('prefers explicit BUTTERBASE_REGION over derivation', () => {
    const cfg = loadRegionConfig({
      BUTTERBASE_REGIONS: 'us-east-1,eu-west-1',
      BUTTERBASE_REGION: 'us-east-1',
      BUTTERBASE_FLY_REGION_MAP: 'iad:us-east-1,lhr:eu-west-1',
      FLY_REGION: 'lhr',
    });
    expect(cfg.instanceRegion).toEqual('us-east-1');
  });

  it('throws when FLY_REGION is set but no map entry exists', () => {
    expect(() =>
      loadRegionConfig({
        BUTTERBASE_REGIONS: 'us-east-1,eu-west-1',
        BUTTERBASE_FLY_REGION_MAP: 'iad:us-east-1',
        FLY_REGION: 'lhr',
      })
    ).toThrow(/FLY_REGION "lhr" has no entry in BUTTERBASE_FLY_REGION_MAP/);
  });

  it('throws when neither BUTTERBASE_REGION nor (FLY_REGION + map) is provided', () => {
    expect(() =>
      loadRegionConfig({ BUTTERBASE_REGIONS: 'us-east-1' })
    ).toThrow(/BUTTERBASE_REGION/);
  });

  it('derived instanceRegion must still be in BUTTERBASE_REGIONS', () => {
    expect(() =>
      loadRegionConfig({
        BUTTERBASE_REGIONS: 'us-east-1',
        BUTTERBASE_FLY_REGION_MAP: 'lhr:eu-west-1',
        FLY_REGION: 'lhr',
      })
    ).toThrow(/not in BUTTERBASE_REGIONS/);
  });

  it('throws when BUTTERBASE_REGION is set but empty (does not silently fall through to FLY_REGION)', () => {
    expect(() =>
      loadRegionConfig({
        BUTTERBASE_REGIONS: 'us-east-1,eu-west-1',
        BUTTERBASE_REGION: '',
        BUTTERBASE_FLY_REGION_MAP: 'iad:us-east-1,lhr:eu-west-1',
        FLY_REGION: 'lhr',
      })
    ).toThrow(/BUTTERBASE_REGION is set but empty/);
  });
});
