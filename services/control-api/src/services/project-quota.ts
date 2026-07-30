import type { Pool } from 'pg';

export type ProjectQuotaCheck =
  | { ok: true }
  | { ok: false; current: number; limit: number };

/**
 * Check whether `organizationId` can create one more app under its plan's
 * `max_projects` limit.
 *
 * Keyed on the TARGET org — not the caller's personal org. A user on the
 * playground plan (personal) can still be a member of a team org on
 * certified/10 and create apps up to that org's cap.
 *
 * `max_projects = -1` means unlimited. If the org has no plan row (data
 * corruption or a not-yet-billed org), fail open — same behavior as the
 * pre-refactor code, so this migration does not tighten quota for orgs
 * that never had one.
 */
export async function checkProjectQuota(
  pool: Pool,
  organizationId: string,
): Promise<ProjectQuotaCheck> {
  const result = await pool.query<{ max_projects: number; current_projects: number }>(
    `SELECT
       p.max_projects,
       (SELECT COUNT(*)::int
          FROM org_app_index
         WHERE organization_id = $1) AS current_projects
     FROM organizations o
     JOIN plans p ON p.id = o.plan_id
     WHERE o.id = $1`,
    [organizationId],
  );
  const row = result.rows[0];
  if (!row) return { ok: true };
  const { max_projects, current_projects } = row;
  if (max_projects === -1) return { ok: true };
  if (current_projects >= max_projects) {
    return { ok: false, current: current_projects, limit: max_projects };
  }
  return { ok: true };
}
