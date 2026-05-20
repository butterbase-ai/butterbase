import type pg from 'pg';

interface OrphanCounts {
  usage_meters: number;
  user_billing_state: Record<string, number>;
}

/**
 * Scans control-DB tables for rows with app_id values that don't exist in any
 * runtime DB. Returns counts per table. Does NOT delete anything — just reports.
 *
 * Application is responsible for deciding whether to delete or alert based on
 * the counts; in v1 we ALWAYS alert and never auto-delete (data preservation
 * over noise reduction).
 */
export async function detectCrossTierOrphans(
  controlDb: pg.Pool | { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  runtimeDbsByRegion: Record<string, pg.Pool | { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }>
): Promise<OrphanCounts> {
  // Collect all known app IDs across all regions
  const knownApps = new Set<string>();
  for (const [, pool] of Object.entries(runtimeDbsByRegion)) {
    const { rows } = await pool.query('SELECT id FROM apps');
    for (const row of rows) knownApps.add(row.id);
  }

  const knownArr = Array.from(knownApps);
  const placeholders = knownArr.length > 0
    ? knownArr.map((_, i) => `$${i + 1}`).join(',')
    : "''"; // empty - no apps means everything is orphan

  const query = (table: string) =>
    knownArr.length > 0
      ? `SELECT count(*)::int AS c FROM ${table} WHERE app_id IS NOT NULL AND app_id NOT IN (${placeholders})`
      : `SELECT count(*)::int AS c FROM ${table} WHERE app_id IS NOT NULL`;

  // Only usage_meters has an app_id column in the control-plane schema.
  // subscriptions and billing_events track billing by user only.
  const [meters] = await Promise.all([
    controlDb.query(query('usage_meters'), knownArr),
  ]);

  // Phase 3 reverse-direction check: user_billing_state rows (per-region runtime
  // DB cache) whose user_id no longer exists in platform_users. Cache rows for
  // deleted users are harmless (never read) but pile up.
  const { rows: platformUsers } = await controlDb.query('SELECT id FROM platform_users');
  const knownUsers = new Set<string>(platformUsers.map((r: any) => r.id));
  const knownUserArr = Array.from(knownUsers);
  const userPlaceholders = knownUserArr.length > 0
    ? knownUserArr.map((_, i) => `$${i + 1}`).join(',')
    : "''";
  const userBillingStateByRegion: Record<string, number> = {};
  for (const [region, pool] of Object.entries(runtimeDbsByRegion)) {
    const sql = knownUserArr.length > 0
      ? `SELECT count(*)::int AS c FROM user_billing_state WHERE user_id NOT IN (${userPlaceholders})`
      : `SELECT count(*)::int AS c FROM user_billing_state`;
    const { rows } = await pool.query(sql, knownUserArr);
    userBillingStateByRegion[region] = rows[0].c;
  }

  return {
    usage_meters: meters.rows[0].c,
    user_billing_state: userBillingStateByRegion,
  };
}

export async function runOrphanCleanup(
  controlDb: pg.Pool,
  runtimeDbsByRegion: Record<string, pg.Pool>
): Promise<void> {
  const counts = await detectCrossTierOrphans(controlDb, runtimeDbsByRegion);
  const ubsTotal = Object.values(counts.user_billing_state).reduce((a, b) => a + b, 0);
  const total = counts.usage_meters + ubsTotal;
  if (total === 0) {
    console.log('[orphan-cleanup] No orphans detected');
    return;
  }
  const ubsBreakdown = Object.entries(counts.user_billing_state)
    .map(([r, c]) => `${r}=${c}`).join(',');
  console.warn(
    `[orphan-cleanup] Found ${total} orphans: ` +
    `usage_meters=${counts.usage_meters}, ` +
    `user_billing_state={${ubsBreakdown}}`
  );
  // v1 does not auto-delete; just alerts. Operator investigates and runs
  // manual SQL if cleanup is appropriate.
}
