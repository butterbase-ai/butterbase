import type { Pool } from 'pg';

/**
 * Resolve the caller's personal organization id for org-scoped inserts.
 *
 * Plan 05 (signup hook) guarantees every platform_users row has a non-null
 * personal_organization_id, and migration 076 enforces it at the DB level.
 * A null return here indicates data corruption or a caller reaching this
 * function with an invalid user id — fail loudly, do NOT paper over.
 *
 * Ship as the single lookup for every INSERT into org-scoped billing tables
 * (api_keys, subscriptions, credit_leases, credit_grants, usage_meters,
 * billing_events). See Plan 07.1.
 */
export async function resolveOrganizationId(pool: Pool, userId: string): Promise<string> {
  const result = await pool.query<{ personal_organization_id: string | null }>(
    'SELECT personal_organization_id FROM platform_users WHERE id = $1',
    [userId],
  );
  if (result.rows.length === 0) {
    throw new Error(`resolveOrganizationId: user ${userId} not found`);
  }
  const orgId = result.rows[0].personal_organization_id;
  if (!orgId) {
    throw new Error(`resolveOrganizationId: user ${userId} has no personal_organization_id`);
  }
  return orgId;
}
