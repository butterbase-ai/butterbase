import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    people: {
      routing: {
        search_person: 'primary',
        search_company: 'secondary',
        get_profile: 'primary',
        queue_email_lookup: 'secondary',
      },
    },
  },
}));

import { resolveSlot } from './routing.js';

describe('resolveSlot', () => {
  it('should return the correct slot for each configured action', () => {
    expect(resolveSlot('search_person')).toBe('primary');
    expect(resolveSlot('search_company')).toBe('secondary');
    expect(resolveSlot('get_profile')).toBe('primary');
    expect(resolveSlot('queue_email_lookup')).toBe('secondary');
  });
});

describe('resolveSlot fallback', () => {
  it('should default to primary for missing actions in routing config', async () => {
    // Reset modules and reimport with partial config
    vi.resetModules();

    // Dynamically mock with partial routing
    vi.doMock('../../config.js', () => ({
      config: {
        people: {
          routing: {
            search_person: 'secondary',
            // Missing search_company, get_profile, queue_email_lookup
          },
        },
      },
    }));

    const { resolveSlot: resolveSlotFallback } = await import('./routing.js');

    expect(resolveSlotFallback('search_person')).toBe('secondary');
    expect(resolveSlotFallback('search_company')).toBe('primary');
    expect(resolveSlotFallback('get_profile')).toBe('primary');
    expect(resolveSlotFallback('queue_email_lookup')).toBe('primary');

    vi.doUnmock('../../config.js');
  });
});
