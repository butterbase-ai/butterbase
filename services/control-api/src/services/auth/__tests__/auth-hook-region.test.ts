import { describe, it, expect, afterEach } from 'vitest';
import { authHookRegionHeaders } from '../auth-hook-service.js';

const ORIGINAL = process.env.BUTTERBASE_FLY_REGION_MAP;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.BUTTERBASE_FLY_REGION_MAP;
  else process.env.BUTTERBASE_FLY_REGION_MAP = ORIGINAL;
});

describe('authHookRegionHeaders', () => {
  it('maps the app home region to its Fly region as Fly-Prefer-Region', () => {
    process.env.BUTTERBASE_FLY_REGION_MAP = 'iad:us-east-1,sjc:us-west-2';
    expect(authHookRegionHeaders('us-west-2')).toEqual({ 'Fly-Prefer-Region': 'sjc' });
    expect(authHookRegionHeaders('us-east-1')).toEqual({ 'Fly-Prefer-Region': 'iad' });
  });

  it('returns no header when the region map is unset (local dev / tests)', () => {
    delete process.env.BUTTERBASE_FLY_REGION_MAP;
    expect(authHookRegionHeaders('us-west-2')).toEqual({});
  });

  it('returns no header when no fly region maps to the home region', () => {
    process.env.BUTTERBASE_FLY_REGION_MAP = 'iad:us-east-1';
    expect(authHookRegionHeaders('eu-west-1')).toEqual({});
  });

  it('returns no header (never throws) when the region map is malformed', () => {
    process.env.BUTTERBASE_FLY_REGION_MAP = 'this-is-not-valid';
    expect(authHookRegionHeaders('us-west-2')).toEqual({});
  });
});
