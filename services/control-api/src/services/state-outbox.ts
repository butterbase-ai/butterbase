import type pg from 'pg';

export const OUTBOX_FIELDS = ['account_status', 'plan_id', 'spending_cap_usd'] as const;
export type OutboxField = typeof OUTBOX_FIELDS[number];

export type UserStateChange = Partial<Record<OutboxField, string | number | null>>;

export interface WriteResult {
  version: number;
}

/**
 * Atomically updates the listed fields on the user's personal organization and
 * writes a paired row to user_state_outbox. Returns the assigned outbox version.
 *
 * Use this for EVERY mutation of organizations.{account_status, plan_id,
 * spending_cap_usd}. Do not write those columns directly with bare UPDATEs.
 *
 * Credit balance changes are handled by the lease subsystem — do not pass
 * credits_usd here.
 */
export async function writeUserStateChange(
  platformPool: pg.Pool,
  userId: string,
  change: UserStateChange
): Promise<WriteResult> {
  const keys = Object.keys(change) as OutboxField[];
  if (keys.length === 0) throw new Error('writeUserStateChange: no fields provided');
  for (const k of keys) {
    if (!OUTBOX_FIELDS.includes(k)) {
      throw new Error(`writeUserStateChange: unsupported field "${k}"`);
    }
  }

  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const values = keys.map((k) => change[k] ?? null);

  const client = await platformPool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE organizations SET ${setClause} WHERE id = (SELECT personal_organization_id FROM platform_users WHERE id = $1)`,
      [userId, ...values]
    );
    if (upd.rowCount === 0) {
      throw new Error(`writeUserStateChange: user ${userId} not found`);
    }
    const ins = await client.query<{ version: string }>(
      `INSERT INTO user_state_outbox (user_id, fields_changed)
       VALUES ($1, $2::jsonb)
       RETURNING version`,
      [userId, JSON.stringify(change)]
    );
    await client.query('COMMIT');
    return { version: parseInt(ins.rows[0].version, 10) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
