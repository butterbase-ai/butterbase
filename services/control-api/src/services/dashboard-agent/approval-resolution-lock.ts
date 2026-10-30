import type pg from 'pg';
import { getApprovalInConversation, type Approval } from './approvals-store.js';

/** Session lock survives the executor's success-cache commit. All nested
 * database work borrows the SAME connection, including with a one-slot pool.
 * It uses a different namespace from executeOnce's transaction lock. */
export async function withApprovalResolutionLock<T>(pool: pg.Pool, approval: Approval, work: (pool: pg.Pool, current: Approval | null) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const key = `approval-resolution:${approval.id}`;
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
    locked = true;
    const borrowed = { query: client.query.bind(client), release() {} } as unknown as pg.PoolClient;
    const scoped = { query: client.query.bind(client), connect: async () => borrowed } as unknown as pg.Pool;
    const current = await getApprovalInConversation(scoped, approval.id, approval.conversationId);
    return await work(scoped, current);
  } finally {
    let discard = false;
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
      catch { discard = true; }
    }
    client.release(discard);
  }
}
