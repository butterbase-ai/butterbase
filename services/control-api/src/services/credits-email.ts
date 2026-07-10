import type { Pool } from 'pg';

const LOW_THRESHOLD = parseFloat(process.env.CREDITS_LOW_THRESHOLD_USD ?? '1.00');

interface UserState {
  email: string;
  auto_refill_enabled: boolean;
  auto_refill_last_failure_reason: string | null;
  credits_low_emailed_at: Date | string | null;
  credits_exhausted_emailed_at: Date | string | null;
  monthly_allowance_usd: string;
  credits_usd: string;
}

export interface MaybeSendArgs {
  db: Pool;
  userId: string;
  postBalance: number;
  /**
   * Injected for testability. Production callers pass the real
   * sendBillingEmail from auth/email-service, which has the signature:
   *   sendBillingEmail(to: string, template: string, data: Record<string, string>)
   */
  sendBillingEmail: (to: string, template: string, data: Record<string, string>) => Promise<void>;
  dashboardUrl?: string;
  resetDate?: string | null;
}

export async function maybeSendCreditsEmail(args: MaybeSendArgs): Promise<void> {
  const { db, userId, postBalance, sendBillingEmail } = args;
  const dashboardUrl = args.dashboardUrl ?? process.env.DASHBOARD_URL ?? '';

  // auto_refill_* / credits_usd / monthly_allowance_usd moved to `organizations`
  // in the per-org billing split (migration 093). Join through the user's
  // personal_organization_id — same pattern router.ts uses when computing
  // postBalance. credits_*_emailed_at (dedup markers) stayed on platform_users.
  const result = await db.query<UserState>(
    `SELECT pu.email,
            o.auto_refill_enabled,
            o.auto_refill_last_failure_reason,
            pu.credits_low_emailed_at,
            pu.credits_exhausted_emailed_at,
            o.monthly_allowance_usd::text AS monthly_allowance_usd,
            o.credits_usd::text            AS credits_usd
       FROM platform_users pu
       JOIN organizations o ON o.id = pu.personal_organization_id
      WHERE pu.id = $1`,
    [userId],
  );

  if (result.rows.length === 0) return;
  const u = result.rows[0];

  // Skip if auto-refill is on and not currently failing.
  if (u.auto_refill_enabled && u.auto_refill_last_failure_reason == null) return;

  const data: Record<string, string> = {
    total_usd: postBalance.toFixed(2),
    monthly_allowance_usd: parseFloat(u.monthly_allowance_usd ?? '0').toFixed(2),
    topup_usd: parseFloat(u.credits_usd ?? '0').toFixed(2),
    reset_date: args.resetDate ?? '',
    dashboard_url: dashboardUrl,
  };

  if (postBalance === 0 && u.credits_exhausted_emailed_at == null) {
    await sendBillingEmail(u.email, 'credits_exhausted', data);
    await db.query(
      `UPDATE platform_users SET credits_exhausted_emailed_at = now() WHERE id = $1`,
      [userId],
    );
    return;
  }

  if (postBalance > 0 && postBalance < LOW_THRESHOLD && u.credits_low_emailed_at == null) {
    await sendBillingEmail(u.email, 'credits_low', data);
    await db.query(
      `UPDATE platform_users SET credits_low_emailed_at = now() WHERE id = $1`,
      [userId],
    );
  }
}

export async function resetCreditsEmailState(db: Pool, userId: string): Promise<void> {
  await db.query(
    `UPDATE platform_users
       SET credits_low_emailed_at = NULL,
           credits_exhausted_emailed_at = NULL
     WHERE id = $1
       AND (credits_low_emailed_at IS NOT NULL OR credits_exhausted_emailed_at IS NOT NULL)`,
    [userId],
  );
}
