import { describe, it, expect, vi } from 'vitest';
import { isolateStagingApp } from './staging-isolation.js';

function fakeDb(counts: number[]) {
  const query = vi.fn();
  counts.forEach((c) => query.mockResolvedValueOnce({ rowCount: c }));
  return { pool: { query } as never, query };
}

describe('isolateStagingApp', () => {
  it('clears connected accounts and disables integrations', async () => {
    const { pool, query } = fakeDb([3, 2]);
    const result = await isolateStagingApp(pool, 'app_staging');
    expect(result).toEqual({ clearedConnectedAccounts: 3, disabledIntegrations: 2 });
    expect(query).toHaveBeenCalledTimes(2);
    for (const call of query.mock.calls) {
      expect(call[1]).toEqual(['app_staging']);
    }
  });

  it('reports zero when the staging app inherited nothing', async () => {
    const { pool } = fakeDb([0, 0]);
    expect(await isolateStagingApp(pool, 'app_staging'))
      .toEqual({ clearedConnectedAccounts: 0, disabledIntegrations: 0 });
  });

  it('never issues a statement without an app_id parameter', async () => {
    const { pool, query } = fakeDb([0, 0]);
    await isolateStagingApp(pool, 'app_staging');
    for (const call of query.mock.calls) {
      expect(call[0]).toContain('app_id = $1');
    }
  });
});
