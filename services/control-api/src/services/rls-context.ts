import type { Pool, PoolClient } from 'pg';

/**
 * Executes a query function inside a transaction with the specified PostgreSQL role
 * and user context, enforcing Row-Level Security (RLS).
 *
 * SET LOCAL is used so the role and GUC variables are scoped to the transaction.
 * Calling this outside a transaction (e.g. a plain client.query without BEGIN)
 * would silently no-op the SET LOCAL — which is why we always BEGIN here.
 */
export async function executeWithRole<T>(
  pool: Pool,
  role: 'butterbase_anon' | 'butterbase_user' | 'butterbase_service',
  userId: string | null,
  queryFn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Switch to non-privileged role so RLS is enforced
    // (connection role has BYPASSRLS on Neon, so RLS is skipped without this)
    await client.query(`SET LOCAL ROLE ${role}`);

    // Set GUC variables — policies and current_user_id() read from these
    await client.query(`SET LOCAL app.role = '${role}'`);

    // Set user ID for butterbase_user role
    if (role === 'butterbase_user' && userId) {
      await client.query(`SET LOCAL request.jwt.claim.sub = '${userId.replace(/'/g, "''")}'`);
    }

    const result = await queryFn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
