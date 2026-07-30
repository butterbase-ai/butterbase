import type { Pool } from 'pg';
import { NotFoundError, AuthorizationError } from './api-errors.js';

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
    throw new NotFoundError('user', userId);
  }
  const orgId = result.rows[0].personal_organization_id;
  if (!orgId) {
    throw new Error(`resolveOrganizationId: user ${userId} has no personal_organization_id`);
  }
  return orgId;
}

/**
 * Assert that `userId` is a member of `orgId`. Throws AuthorizationError (403)
 * otherwise. Use when a caller supplies an explicit target org (e.g. body
 * `organization_id` on `/init`) and we need to gate the write on membership.
 *
 * NOTE: this only checks membership, not per-key scope. A bb_sk_* key bound
 * to org X can currently create resources in any org its owning user belongs
 * to. Tighten later if strict per-key scoping is required.
 */
export async function assertOrgMember(pool: Pool, userId: string, orgId: string): Promise<void> {
  const result = await pool.query(
    'SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2 LIMIT 1',
    [orgId, userId],
  );
  if (result.rowCount === 0) {
    throw new AuthorizationError(
      `user is not a member of organization ${orgId}`,
      'AUTH_ORG_FORBIDDEN',
    );
  }
}
