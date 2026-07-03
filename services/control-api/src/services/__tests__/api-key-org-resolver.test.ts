import { describe, it, expect, vi } from 'vitest';
import { resolveOrgFromApiKey } from '../api-key-org-resolver.js';
import { NotFoundError } from '../api-errors.js';

function mockPool(rows: Array<{ organization_id: string | null }>) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as any;
}

describe('resolveOrgFromApiKey', () => {
  it('returns organization_id for a valid api key', async () => {
    const pool = mockPool([{ organization_id: 'org-123' }]);
    const orgId = await resolveOrgFromApiKey(pool, 'key-1');
    expect(orgId).toBe('org-123');
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT organization_id FROM api_keys WHERE id = $1',
      ['key-1'],
    );
  });

  it('throws NotFoundError for an unknown key id', async () => {
    const pool = mockPool([]);
    await expect(resolveOrgFromApiKey(pool, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws when api_key row has NULL organization_id', async () => {
    const pool = mockPool([{ organization_id: null }]);
    await expect(resolveOrgFromApiKey(pool, 'key-null')).rejects.toThrow(/has no organization_id/);
  });
});
