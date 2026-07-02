import { describe, it, expect, vi } from 'vitest';
import { resolveOrgFromApp } from './app-org-resolver.js';

function mockPool(rows: Array<{ organization_id: string | null }>) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as any;
}

describe('resolveOrgFromApp', () => {
  it('returns organization_id when apps row exists and has non-null org', async () => {
    const pool = mockPool([{ organization_id: 'org-42' }]);
    expect(await resolveOrgFromApp(pool, 'app-1')).toBe('org-42');
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT organization_id FROM apps WHERE id = $1',
      ['app-1'],
    );
  });
  it('throws when app not found', async () => {
    const pool = mockPool([]);
    await expect(resolveOrgFromApp(pool, 'missing')).rejects.toThrow(/app missing not found/i);
  });
  it('throws when apps row has NULL organization_id', async () => {
    const pool = mockPool([{ organization_id: null }]);
    await expect(resolveOrgFromApp(pool, 'app-x')).rejects.toThrow(/app app-x has no organization_id/i);
  });
});
