import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pool } from 'pg';

const fireCreditsEmailForOrg = vi.fn(async () => undefined);
vi.mock('../credits-email.js', () => ({ fireCreditsEmailForOrg }));

const { deductCreditsBalance } = await import('../usage-metering.js');

/** Gives back a real `pg.Pool` whose query is stubbed, so the production
 *  `instanceof Pool` guard sees the genuine article. */
function realPoolWithStubbedQuery(remaining: string) {
  const pool = new Pool({ connectionString: 'postgresql://user:pw@127.0.0.1:1/db' });
  pool.query = vi.fn(async () => ({ rows: [{ credits_usd: remaining }], rowCount: 1 })) as never;
  return pool;
}

beforeEach(() => { fireCreditsEmailForOrg.mockClear(); });

describe('deductCreditsBalance credits-email hook', () => {
  it('warns the org after a debit when handed a Pool', async () => {
    const pool = realPoolWithStubbedQuery('-0.0040');
    await deductCreditsBalance(pool, 'org-1', 0.5);
    expect(fireCreditsEmailForOrg).toHaveBeenCalledTimes(1);
    expect(fireCreditsEmailForOrg.mock.calls[0][1]).toBe('org-1');
    await pool.end().catch(() => {});
  });

  it('does not fire when handed an in-transaction client', async () => {
    // A PoolClient here means the caller is mid-transaction. Sending mail and
    // stamping a dedup marker inside someone else's transaction is how you get
    // an email for a debit that then rolls back.
    const client = { query: vi.fn(async () => ({ rows: [{ credits_usd: '-0.0040' }], rowCount: 1 })) };
    await deductCreditsBalance(client as never, 'org-1', 0.5);
    expect(fireCreditsEmailForOrg).not.toHaveBeenCalled();
  });

  it('still returns the amount deducted when the warning path is used', async () => {
    const pool = realPoolWithStubbedQuery('0.5000');
    const deducted = await deductCreditsBalance(pool, 'org-1', 0.5);
    expect(deducted).toBe(0.5);
    await pool.end().catch(() => {});
  });
});
