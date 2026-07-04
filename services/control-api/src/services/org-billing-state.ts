import type pg from 'pg';

export interface OrgBillingState {
  user_id: string;
  plan_id: string | null;
  account_status: string | null;
  spending_cap_usd: number | string | null;
  topup_lease_remaining_usd: number | string;
  lease_expires_at: Date | null;
  last_outbox_version: number | string;
}

export async function readOrgBillingState(
  runtimePool: pg.Pool,
  userId: string
): Promise<OrgBillingState | null> {
  const r = await runtimePool.query<OrgBillingState>(
    `SELECT user_id, plan_id, account_status, spending_cap_usd,
            topup_lease_remaining_usd, lease_expires_at, last_outbox_version
     FROM user_billing_state WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] ?? null;
}

export async function applyLease(
  runtimePool: pg.Pool,
  userId: string,
  amountUsd: number,
  expiresAt: Date
): Promise<void> {
  await runtimePool.query(
    `INSERT INTO user_billing_state (user_id, topup_lease_remaining_usd, lease_expires_at, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
     SET topup_lease_remaining_usd = EXCLUDED.topup_lease_remaining_usd,
         lease_expires_at = EXCLUDED.lease_expires_at,
         updated_at = now()`,
    [userId, amountUsd, expiresAt]
  );
}

export interface BurnResult {
  allowed: boolean;
  remaining: number;
}

export async function burnLease(
  runtimePool: pg.Pool,
  userId: string,
  amountUsd: number
): Promise<BurnResult> {
  const r = await runtimePool.query<{ topup_lease_remaining_usd: string }>(
    `UPDATE user_billing_state
     SET topup_lease_remaining_usd = topup_lease_remaining_usd - $2,
         updated_at = now()
     WHERE user_id = $1
       AND topup_lease_remaining_usd >= $2
       AND lease_expires_at > now()
     RETURNING topup_lease_remaining_usd`,
    [userId, amountUsd]
  );
  if (r.rows.length === 0) {
    const cur = await readOrgBillingState(runtimePool, userId);
    return {
      allowed: false,
      remaining: cur ? parseFloat(String(cur.topup_lease_remaining_usd)) : 0,
    };
  }
  return { allowed: true, remaining: parseFloat(r.rows[0].topup_lease_remaining_usd) };
}
