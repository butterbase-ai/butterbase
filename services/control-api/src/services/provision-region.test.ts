import { describe, it, expect } from 'vitest';
import {
  parseRegionList,
  getProvisionAllowedRegions,
  resolveProvisionRegion,
} from './provision-region.js';

describe('parseRegionList', () => {
  it('splits, trims, and drops empties', () => {
    expect(parseRegionList(' us-east-1 , us-west-2 ,, ')).toEqual(['us-east-1', 'us-west-2']);
  });

  it('returns an empty list for undefined or blank', () => {
    expect(parseRegionList(undefined)).toEqual([]);
    expect(parseRegionList('')).toEqual([]);
    expect(parseRegionList('   ')).toEqual([]);
  });
});

describe('getProvisionAllowedRegions', () => {
  it('prefers the provisioning-specific var', () => {
    expect(getProvisionAllowedRegions({
      BUTTERBASE_PROVISION_ALLOWED_REGIONS: 'us-west-2',
      BUTTERBASE_REGIONS: 'us-east-1,us-west-2',
    } as NodeJS.ProcessEnv)).toEqual(['us-west-2']);
  });

  it('falls back to BUTTERBASE_REGIONS when the specific var is unset', () => {
    expect(getProvisionAllowedRegions({
      BUTTERBASE_REGIONS: 'us-east-1,us-west-2',
    } as NodeJS.ProcessEnv)).toEqual(['us-east-1', 'us-west-2']);
  });

  it('returns empty when neither is set', () => {
    expect(getProvisionAllowedRegions({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe('resolveProvisionRegion', () => {
  it('keeps the requested region when it is open', () => {
    expect(resolveProvisionRegion('us-east-1', ['us-east-1', 'us-west-2'])).toEqual({
      region: 'us-east-1',
      requestedRegion: 'us-east-1',
      redirected: false,
    });
  });

  it('redirects to the first open region when the requested one is closed', () => {
    expect(resolveProvisionRegion('us-east-1', ['us-west-2'])).toEqual({
      region: 'us-west-2',
      requestedRegion: 'us-east-1',
      redirected: true,
    });
  });

  it('treats an empty allow-list as no restriction, NOT as everything-closed', () => {
    // A missing/blank env var must not take provisioning down. If this ever
    // inverted, every /init would redirect to provisionAllowed[0] === undefined.
    expect(resolveProvisionRegion('us-east-1', [])).toEqual({
      region: 'us-east-1',
      requestedRegion: 'us-east-1',
      redirected: false,
    });
  });

  it('never reports redirected when the region did not change', () => {
    // Guards the response contract: `region_redirected_from` is only emitted
    // when redirected is true, so a false positive would tell a customer their
    // app moved when it did not.
    const r = resolveProvisionRegion('us-west-2', ['us-west-2', 'us-east-1']);
    expect(r.redirected).toBe(false);
    expect(r.region).toBe(r.requestedRegion);
  });

  it('redirects both regions to the single open one when only one is open', () => {
    expect(resolveProvisionRegion('us-west-2', ['us-east-1']).region).toBe('us-east-1');
    expect(resolveProvisionRegion('us-east-1', ['us-west-2']).region).toBe('us-west-2');
  });
});
