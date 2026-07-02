import type pg from 'pg';
import { getRuntimeDbPool } from './runtime-db.js';
import { config } from '../config.js';
import { resolveOrganizationId } from './org-resolver.js';

/**
 * Result of a single reaper run, returned to operators / the admin endpoint
 * so they can audit what changed.
 */
export interface AppIndexReaperReport {
  /** Apps that existed in user_app_index but the apps row is missing in every
   *  region — these index entries were deleted. */
  orphanIndexEntriesDeleted: string[];
  /** Apps that existed in a region's apps table but had no user_app_index
   *  entry — these were backfilled. */
  missingIndexEntriesBackfilled: Array<{ app_id: string; region: string }>;
  /** Apps where user_app_index.region disagreed with the region that actually
   *  has the apps row — the index entry was updated to the correct region. */
  wrongRegionFixed: Array<{ app_id: string; from: string; to: string }>;
  /** Per-region apps counts that the reaper saw at the start of the run. */
  perRegionAppsCounts: Record<string, number>;
}

interface IndexRow {
  app_id: string;
  user_id: string;
  region: string;
  subdomain: string | null;
  app_name: string | null;
}

interface AppRow {
  id: string;
  owner_id: string;
  subdomain: string | null;
  name: string | null;
}

/**
 * Reconciles `user_app_index` (control DB) with every region's `apps` table
 * (runtime DB). Fixes three classes of drift:
 *
 *   1. **Orphan index entries** — index says the app exists somewhere but
 *      no region's runtime DB has the apps row. The deprovision worker
 *      cleaned the row but failed the safety-net removeUserAppIndex.
 *      → DELETE the orphan index entry.
 *
 *   2. **Missing index entries** — a region has an apps row but the index
 *      doesn't know about it. Pre-Phase-1 apps from before user_app_index
 *      backfill, or failed addUserAppIndex calls.
 *      → INSERT the index entry with the correct region.
 *
 *   3. **Wrong-region index entries** — index points at one region but the
 *      apps row is actually in another. Shouldn't happen post-Phase-1 but
 *      possible from in-flight move-app failures.
 *      → UPDATE the index entry to the region that actually holds the row.
 *
 * Idempotent: running it twice in a row on a consistent system is a no-op.
 * Safe to run while the API is serving traffic: all three operations are
 * single-row UPSERTs.
 */
export async function reapAppIndex(controlDb: pg.Pool): Promise<AppIndexReaperReport> {
  const regions = Object.keys(config.runtimeDb.urlsByRegion);

  // 1) snapshot per-region apps rows
  const appsByRegion: Record<string, AppRow[]> = {};
  for (const region of regions) {
    const pool = getRuntimeDbPool(config.runtimeDb, region);
    const { rows } = await pool.query<AppRow>(
      'SELECT id, owner_id, subdomain, name FROM apps',
    );
    appsByRegion[region] = rows;
  }
  // build app_id → owning region (assumes app rows are disjoint across regions)
  const appOwningRegion = new Map<string, { region: string; row: AppRow }>();
  for (const [region, rows] of Object.entries(appsByRegion)) {
    for (const row of rows) {
      appOwningRegion.set(row.id, { region, row });
    }
  }

  // 2) snapshot user_app_index
  const { rows: indexRows } = await controlDb.query<IndexRow>(
    'SELECT app_id, user_id, region, subdomain, app_name FROM user_app_index',
  );
  const indexByAppId = new Map<string, IndexRow>(indexRows.map((r) => [r.app_id, r]));

  const orphanIndexEntriesDeleted: string[] = [];
  const wrongRegionFixed: AppIndexReaperReport['wrongRegionFixed'] = [];
  const missingIndexEntriesBackfilled: AppIndexReaperReport['missingIndexEntriesBackfilled'] = [];

  // 3) reconcile index → runtime
  for (const idx of indexRows) {
    const owner = appOwningRegion.get(idx.app_id);
    if (!owner) {
      // Orphan: no region has the apps row.
      await controlDb.query('DELETE FROM user_app_index WHERE app_id = $1', [idx.app_id]);
      orphanIndexEntriesDeleted.push(idx.app_id);
      continue;
    }
    if (owner.region !== idx.region) {
      // Wrong region: index points at one region, apps row is in another.
      await controlDb.query(
        'UPDATE user_app_index SET region = $2, updated_at = now() WHERE app_id = $1',
        [idx.app_id, owner.region],
      );
      wrongRegionFixed.push({ app_id: idx.app_id, from: idx.region, to: owner.region });
    }
  }

  // 4) reconcile runtime → index (missing entries)
  for (const [region, rows] of Object.entries(appsByRegion)) {
    for (const row of rows) {
      if (indexByAppId.has(row.id)) continue;
      const organizationId = await resolveOrganizationId(controlDb, row.owner_id);
      await controlDb.query(
        `INSERT INTO user_app_index (app_id, user_id, organization_id, region, subdomain, app_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (app_id) DO NOTHING`,
        [row.id, row.owner_id, organizationId, region, row.subdomain, row.name],
      );
      missingIndexEntriesBackfilled.push({ app_id: row.id, region });
    }
  }

  const perRegionAppsCounts: Record<string, number> = {};
  for (const [region, rows] of Object.entries(appsByRegion)) {
    perRegionAppsCounts[region] = rows.length;
  }

  return {
    orphanIndexEntriesDeleted,
    missingIndexEntriesBackfilled,
    wrongRegionFixed,
    perRegionAppsCounts,
  };
}
