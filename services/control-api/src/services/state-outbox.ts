import type pg from 'pg';
import { resolveOrganizationId } from './org-resolver.js';
import { NotFoundError } from './api-errors.js';

export const OUTBOX_FIELDS = ['account_status', 'plan_id', 'spending_cap_usd'] as const;
export type OutboxField = typeof OUTBOX_FIELDS[number];

export type UserStateChange = Partial<Record<OutboxField, string | number | null>>;

export interface WriteResult {
  version: number;
}

/**
 * Atomically updates the listed fields on the target organization and writes a
 * paired row to user_state_outbox. Returns the assigned outbox version.
 *
 * Target org resolution:
 *   - If `organizationId` is provided, that org is updated. Callers on the
 *     billing path (checkout, subscription cancel) MUST pass it — a team-org
 *     member checking out otherwise mis-routes the plan_id write to the
 *     acting user's personal org (incident 2026-07-14).
 *   - If omitted, falls back to `platform_users.personal_organization_id` for
 *     `userId`. Kept for callers where user == org (soft-lock, spending cap
 *     bumps on the personal org, etc.).
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
  change: UserStateChange,
  organizationId?: string
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
    const upd = organizationId
      ? await client.query(
          `UPDATE organizations SET ${setClause} WHERE id = $1`,
          [organizationId, ...values]
        )
      : await client.query(
          `UPDATE organizations SET ${setClause} WHERE id = (SELECT personal_organization_id FROM platform_users WHERE id = $1)`,
          [userId, ...values]
        );
    if (upd.rowCount === 0) {
      throw new NotFoundError(organizationId ? 'organization' : 'user', organizationId ?? userId);
    }
    const outboxOrgId = organizationId ?? (await resolveOrganizationId(platformPool, userId));
    const ins = await client.query<{ version: string }>(
      `INSERT INTO user_state_outbox (user_id, organization_id, fields_changed)
       VALUES ($1, $2, $3::jsonb)
       RETURNING version`,
      [userId, outboxOrgId, JSON.stringify(change)]
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
