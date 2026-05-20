import { describe, it, expect } from 'vitest';
import { getBillingProvider, setBillingProvider } from './provider-registry.js';
import { NoopBillingProvider } from '@butterbase/shared';

describe('billing provider registry', () => {
  it('returns NoopBillingProvider when nothing registered', () => {
    setBillingProvider(null);
    const provider = getBillingProvider();
    expect(provider).toBeInstanceOf(NoopBillingProvider);
  });

  it('returns the registered provider', () => {
    const custom = new NoopBillingProvider();
    setBillingProvider(custom);
    expect(getBillingProvider()).toBe(custom);
  });
});
