import { describe, it, expect } from 'vitest';
import { getQuotaEnforcer, setQuotaEnforcer } from './enforcer-registry.js';
import { UnlimitedQuotaEnforcer } from '@butterbase/shared';

describe('quota enforcer registry', () => {
  it('returns UnlimitedQuotaEnforcer when nothing registered', () => {
    setQuotaEnforcer(null);
    expect(getQuotaEnforcer()).toBeInstanceOf(UnlimitedQuotaEnforcer);
  });

  it('returns the registered enforcer', () => {
    const custom = new UnlimitedQuotaEnforcer();
    setQuotaEnforcer(custom);
    expect(getQuotaEnforcer()).toBe(custom);
  });
});
