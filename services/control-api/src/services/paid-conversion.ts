/**
 * Paid-conversion metric — what share of real customers are on a paid plan.
 *
 * Source of truth is the `subscriptions` table, NOT `organizations.plan_id`.
 * The two disagree in both directions: orgs soft-locked to playground while a
 * launch sub is still in dunning, and orgs left on launch after the sub was
 * cancelled. Reading plan_id would over-report paying orgs.
 *
 * Ownership is `organizations.owner_id` (NOT NULL, exactly one per org) rather
 * than organization_members(role='owner'), which permits several owners per org
 * and is missing rows for some orgs. owner_id has no FK, so the join through
 * platform_users is what drops orgs whose owner no longer exists.
 *
 * "Internal" covers staff and seeded demo accounts. is_admin alone is not
 * enough — two internal accounts are not flagged admin, and one of them owns
 * eleven demo orgs carrying live Stripe subscriptions. Both rules are applied.
 */

const INTERNAL_EMAILS = ['kcflexigbo@gmail.com', 'hi.networksage@gmail.com'];

/** Plans that represent actual recurring revenue. */
const PAID_PLANS = ['launch', 'certified'];

/**
 * Strict counts a subscription only while it is active AND has no scheduled
 * end date. Stripe sets `cancel_at` on portal-initiated cancellations, which we
 * would otherwise keep reporting as revenue — including some whose date has
 * already passed. Broad additionally counts past_due (dunning).
 */
export const PAID_CONVERSION_SQL = `
WITH internal AS (
  SELECT id FROM platform_users
  WHERE email LIKE '%@butterbase.ai'
     OR email = ANY($1::text[])
     OR is_admin
),
ext_users AS (
  SELECT id FROM platform_users WHERE id NOT IN (SELECT id FROM internal)
),
ext_orgs AS (
  SELECT o.id, o.owner_id
  FROM organizations o
  JOIN ext_users u ON u.id = o.owner_id
),
strict_orgs AS (
  SELECT eo.id, eo.owner_id FROM ext_orgs eo
  WHERE EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.organization_id = eo.id
      AND s.plan_id = ANY($2::text[])
      AND s.status = 'active'
      AND s.cancel_at IS NULL
  )
),
broad_orgs AS (
  SELECT eo.id, eo.owner_id FROM ext_orgs eo
  WHERE EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.organization_id = eo.id
      AND s.plan_id = ANY($2::text[])
      AND s.status IN ('active', 'past_due')
  )
)
SELECT
  (SELECT count(*)::int FROM ext_users)                        AS eligible_users,
  (SELECT count(*)::int FROM ext_orgs)                         AS eligible_orgs,
  (SELECT count(DISTINCT owner_id)::int FROM strict_orgs)      AS paying_users,
  (SELECT count(*)::int FROM strict_orgs)                      AS paying_orgs,
  (SELECT count(DISTINCT owner_id)::int FROM broad_orgs)       AS broad_paying_users,
  (SELECT count(*)::int FROM broad_orgs)                       AS broad_paying_orgs
`;

export interface PaidConversion {
  eligibleUsers: number;
  eligibleOrgs: number;
  payingUsers: number;
  payingOrgs: number;
  payingUsersPct: number;
  payingOrgsPct: number;
  broadPayingUsers: number;
  broadPayingOrgs: number;
  broadPayingUsersPct: number;
  broadPayingOrgsPct: number;
}

function pct(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export async function queryPaidConversion(db: Queryable): Promise<PaidConversion> {
  const { rows } = await db.query(PAID_CONVERSION_SQL, [INTERNAL_EMAILS, PAID_PLANS]);
  const r = rows[0];
  const eligibleUsers = r.eligible_users;
  const eligibleOrgs = r.eligible_orgs;
  return {
    eligibleUsers,
    eligibleOrgs,
    payingUsers: r.paying_users,
    payingOrgs: r.paying_orgs,
    payingUsersPct: pct(r.paying_users, eligibleUsers),
    payingOrgsPct: pct(r.paying_orgs, eligibleOrgs),
    broadPayingUsers: r.broad_paying_users,
    broadPayingOrgs: r.broad_paying_orgs,
    broadPayingUsersPct: pct(r.broad_paying_users, eligibleUsers),
    broadPayingOrgsPct: pct(r.broad_paying_orgs, eligibleOrgs),
  };
}

/**
 * Records the current conversion figures for one day. Keyed on date and
 * idempotent, so re-running it (a retry, or a second process winning the
 * nightly lock) overwrites that day rather than duplicating it.
 *
 * `snapshotDate` defaults to the current UTC date. It is a parameter so tests
 * can pin a date without stubbing the clock.
 */
export async function writePaidConversionSnapshot(
  db: Queryable,
  snapshotDate?: string,
): Promise<PaidConversion> {
  const conversion = await queryPaidConversion(db);
  await db.query(
    `INSERT INTO paid_conversion_snapshots (
       snapshot_date, paying_users, paying_orgs,
       broad_paying_users, broad_paying_orgs,
       eligible_users, eligible_orgs
     ) VALUES (COALESCE($1::date, (now() AT TIME ZONE 'utc')::date), $2, $3, $4, $5, $6, $7)
     ON CONFLICT (snapshot_date) DO UPDATE SET
       paying_users       = EXCLUDED.paying_users,
       paying_orgs        = EXCLUDED.paying_orgs,
       broad_paying_users = EXCLUDED.broad_paying_users,
       broad_paying_orgs  = EXCLUDED.broad_paying_orgs,
       eligible_users     = EXCLUDED.eligible_users,
       eligible_orgs      = EXCLUDED.eligible_orgs,
       captured_at        = now()`,
    [
      snapshotDate ?? null,
      conversion.payingUsers,
      conversion.payingOrgs,
      conversion.broadPayingUsers,
      conversion.broadPayingOrgs,
      conversion.eligibleUsers,
      conversion.eligibleOrgs,
    ],
  );
  return conversion;
}
