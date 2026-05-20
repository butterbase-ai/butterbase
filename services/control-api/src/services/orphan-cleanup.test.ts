import { describe, it, expect, vi } from 'vitest';
import { detectCrossTierOrphans } from './orphan-cleanup.js';

describe('detectCrossTierOrphans', () => {
  it('returns counts per cross-tier-FK table', async () => {
    const fakeControlDb = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('usage_meters')) return { rows: [{ c: 5 }] };
        if (sql.includes('platform_users')) return { rows: [{ id: 'u1' }, { id: 'u2' }] };
        return { rows: [{ c: 0 }] };
      }),
    } as any;
    const fakeRuntimeDbsByRegion = {
      'us-east-1': {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('user_billing_state')) return { rows: [{ c: 2 }] };
          return { rows: [{ id: 'app1' }, { id: 'app2' }] };
        }),
      } as any,
    };
    const result = await detectCrossTierOrphans(fakeControlDb, fakeRuntimeDbsByRegion);
    expect(result.usage_meters).toBe(5);
    expect(result.user_billing_state).toEqual({ 'us-east-1': 2 });
  });
});
