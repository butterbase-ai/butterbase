import type { Pool } from 'pg';

/**
 * Fallback trigger point for the low-balance warning, used when the org has
 * not configured `auto_refill_threshold_usd`. Kept as an env var because it
 * predates the per-org column and some deployments set it.
 */
const DEFAULT_LOW_THRESHOLD = parseFloat(process.env.CREDITS_LOW_THRESHOLD_USD ?? '1.00');

interface OrgState {
  auto_refill_enabled: boolean;
  auto_refill_last_failure_reason: string | null;
  auto_refill_threshold_usd: string | null;
  credits_low_emailed_at: Date | string | null;
  credits_exhausted_emailed_at: Date | string | null;
  monthly_allowance_usd: string;
  credits_usd: string;
}

export interface MaybeSendArgs {
  db: Pool;
  /**
   * The org whose balance was drawn — NOT the caller's personal org. Under
   * per-org billing these differ for every team-org request, and keying this
   * to the user was why team orgs were never warned: the query read the
   * caller's personal balance, which the request had not touched.
   */
  organizationId: string;
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
  const { db, organizationId, postBalance, sendBillingEmail } = args;
  const dashboardUrl = args.dashboardUrl ?? process.env.DASHBOARD_URL ?? '';

  // Balance, auto-refill config and the dedup markers all live on
  // `organizations` as of migration 113 — one row, no join through
  // platform_users. Recipients are resolved separately, below.
  const result = await db.query<OrgState>(
    `SELECT o.auto_refill_enabled,
            o.auto_refill_last_failure_reason,
            o.auto_refill_threshold_usd::text AS auto_refill_threshold_usd,
            o.credits_low_emailed_at,
            o.credits_exhausted_emailed_at,
            o.monthly_allowance_usd::text AS monthly_allowance_usd,
            o.credits_usd::text            AS credits_usd
       FROM organizations o
      WHERE o.id = $1`,
    [organizationId],
  );

  if (result.rows.length === 0) return;
  const o = result.rows[0];

  // Skip if auto-refill is on and not currently failing — a working auto-refill
  // means the balance is about to be topped up, so there is nothing to warn
  // about. A failing one is exactly when the warning matters most.
  if (o.auto_refill_enabled && o.auto_refill_last_failure_reason == null) return;

  // Warn at the org's own trigger point when it has set one, so "tell me when
  // I drop below $X" holds whether or not the card charge succeeds. Orgs that
  // never configured a threshold keep the deployment-wide default.
  const parsedThreshold = o.auto_refill_threshold_usd != null
    ? parseFloat(o.auto_refill_threshold_usd)
    : NaN;
  const threshold = Number.isFinite(parsedThreshold) && parsedThreshold > 0
    ? parsedThreshold
    : DEFAULT_LOW_THRESHOLD;

  const wantsExhausted = postBalance === 0 && o.credits_exhausted_emailed_at == null;
  const wantsLow = postBalance > 0 && postBalance < threshold && o.credits_low_emailed_at == null;
  if (!wantsExhausted && !wantsLow) return;

  const recipients = await orgOwnerEmails(db, organizationId);
  if (recipients.length === 0) return;

  const data: Record<string, string> = {
    total_usd: postBalance.toFixed(2),
    monthly_allowance_usd: parseFloat(o.monthly_allowance_usd ?? '0').toFixed(2),
    topup_usd: parseFloat(o.credits_usd ?? '0').toFixed(2),
    threshold_usd: threshold.toFixed(2),
    reset_date: args.resetDate ?? '',
    dashboard_url: dashboardUrl,
  };

  const template = wantsExhausted ? 'credits_exhausted' : 'credits_low';
  const marker = wantsExhausted ? 'credits_exhausted_emailed_at' : 'credits_low_emailed_at';

  // Stamp the marker BEFORE sending. A duplicate warning to every owner of an
  // org is worse than a missed one, and settles are concurrent: two calls
  // finishing together would both read a NULL marker and both send. Stamping
  // first means the loser of that race sees the mark and drops out.
  const claimed = await db.query(
    `UPDATE organizations SET ${marker} = now()
      WHERE id = $1 AND ${marker} IS NULL`,
    [organizationId],
  );
  if (claimed.rowCount === 0) return;

  // Send to every owner, the same recipient set auto-refill failures use.
  // Failures are per-recipient: one bad address must not suppress the rest,
  // and the marker stays stamped either way — a warning email is not worth
  // re-attempting on the next settle.
  await Promise.all(
    recipients.map((to) =>
      Promise.resolve()
        .then(() => sendBillingEmail(to, template, data))
        .catch((err) => console.error(`[credits-email] ${template} to ${to} failed:`, err)),
    ),
  );
}

/**
 * Every owner of the org. For a personal org that is the single account
 * holder; for a team org it is each member with role='owner'.
 */
async function orgOwnerEmails(db: Pool, organizationId: string): Promise<string[]> {
  const { rows } = await db.query<{ email: string }>(
    `SELECT DISTINCT pu.email
       FROM organization_members om
       JOIN platform_users pu ON pu.id = om.user_id
      WHERE om.organization_id = $1 AND om.role = 'owner' AND pu.email IS NOT NULL`,
    [organizationId],
  );
  return rows.map((r) => r.email);
}

/**
 * Convenience wrapper for callers that only hold a user id and are crediting
 * that user's personal org (signup grants). Team-org callers must pass the org
 * id to `resetCreditsEmailState` directly — there is no user-to-org shortcut
 * that is correct for them.
 */
export async function resetCreditsEmailStateForUserPersonalOrg(db: Pool, userId: string): Promise<void> {
  await db.query(
    `UPDATE organizations o
        SET credits_low_emailed_at = NULL,
            credits_exhausted_emailed_at = NULL
       FROM platform_users pu
      WHERE pu.id = $1
        AND o.id = pu.personal_organization_id
        AND (o.credits_low_emailed_at IS NOT NULL OR o.credits_exhausted_emailed_at IS NOT NULL)`,
    [userId],
  );
}

export async function resetCreditsEmailState(db: Pool, organizationId: string): Promise<void> {
  await db.query(
    `UPDATE organizations
       SET credits_low_emailed_at = NULL,
           credits_exhausted_emailed_at = NULL
     WHERE id = $1
       AND (credits_low_emailed_at IS NOT NULL OR credits_exhausted_emailed_at IS NOT NULL)`,
    [organizationId],
  );
}
