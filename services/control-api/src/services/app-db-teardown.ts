import * as neonClient from './neon-client.js';
import { getDataProjectIdForRegion } from './neon-projects.js';

/**
 * Shape of the teardown that ran, so callers can log precisely without
 * re-deriving the discriminator.
 *
 *  - `legacy`   the app's database lives *inside* the region's shared data
 *               project; only that database was dropped.
 *  - `tenant`   the app owns its Neon project outright (project-per-tenant);
 *               the whole project was deleted.
 *  - `skipped`  nothing identifiable to delete (no project id / db name).
 */
export interface AppDbTeardownResult {
  mode: 'legacy' | 'tenant' | 'skipped';
  /** Project the teardown acted on. Absent for `skipped`. */
  projectId?: string;
  /** Database dropped. Only set for `legacy`. */
  databaseName?: string;
  /** True when Neon answered 404 / "not found" — already gone, treated as success. */
  alreadyGone: boolean;
  /**
   * True when `getDataProjectIdForRegion(region)` threw — the region is no
   * longer in `BUTTERBASE_REGIONS` — and the teardown fell back to the
   * legacy branch *unable to prove* this app isn't actually a tenant
   * project. The fallback direction is correct (see function doc), but if
   * this app really does own a dedicated Neon project, that project is now
   * orphaned and `neon-orphan-reconciler.ts` can't see it either, since it
   * calls the same throwing helper. Only ever set (to `true`) on the
   * degraded path; absent otherwise, so it never fires for the normal case
   * where the region simply has no shared data project configured.
   */
  degraded?: boolean;
}

export interface TeardownAppDbArgs {
  /** Region whose *shared* data project acts as the legacy discriminator. */
  region: string;
  /** `app_db_connections.neon_project_id` for the app, if a row was found. */
  neonProjectId?: string | null;
  /** `app_db_connections.neon_database_name` (or the caller's known db name). */
  neonDatabaseName?: string | null;
}

function isAlreadyGone(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : '';
  return msg.includes('404') || msg.includes('not found');
}

/**
 * Deletes an app's Neon data-plane storage, picking the right teardown shape.
 *
 * The discriminator is deliberately **data-driven** — the app's own stored
 * `neon_project_id` — and NOT `config.neon.projectPerTenant`. The flag can be
 * flipped between the moment an app was provisioned and the moment it is
 * deleted, so the flag says nothing about what this particular app actually
 * owns; the stored project id is the only reliable truth.
 *
 * If the stored project is the region's shared data project, the app is a
 * legacy tenant: drop just its `cust_*` database, under the per-project lock
 * that serializes Neon mutations on that busy shared project. Anything else
 * means provisioning took the project-per-tenant path and created a dedicated
 * project — deleting only the database inside it would leave the project
 * orphaned and billing forever, invisible to both the app and the legacy
 * orphan reconciler, so the whole project goes.
 *
 * Idempotent: a 404 / "not found" from Neon is success (`alreadyGone: true`),
 * matching the existing teardown call sites. Any other failure is rethrown —
 * callers own the error contract (rethrow vs. warn-and-continue).
 */
export async function teardownAppDb(args: TeardownAppDbArgs): Promise<AppDbTeardownResult> {
  const { region, neonProjectId, neonDatabaseName } = args;

  // A region with no configured shared data project id cannot prove the app is
  // a tenant, so fall back to legacy — the pre-existing behaviour — rather than
  // deleting a project we may not own. `degraded` distinguishes "the helper
  // threw" (region config gap — the risky case, see AppDbTeardownResult) from
  // the ordinary "no shared project configured for this region" case.
  let sharedProjectId: string | null = null;
  let degraded = false;
  try {
    sharedProjectId = getDataProjectIdForRegion(region) || null;
  } catch {
    sharedProjectId = null;
    degraded = true;
  }
  const degradedFlag = degraded ? { degraded: true as const } : {};

  if (neonProjectId && sharedProjectId && neonProjectId !== sharedProjectId) {
    try {
      await neonClient.withNeonProjectLock(neonProjectId, () => neonClient.deleteProject(neonProjectId));
    } catch (err) {
      if (!isAlreadyGone(err)) throw err;
      return { mode: 'tenant', projectId: neonProjectId, alreadyGone: true };
    }
    return { mode: 'tenant', projectId: neonProjectId, alreadyGone: false };
  }

  const projectId = neonProjectId || sharedProjectId;
  if (!projectId || !neonDatabaseName) {
    return { mode: 'skipped', alreadyGone: false, ...degradedFlag };
  }

  try {
    await neonClient.withNeonProjectLock(projectId, () =>
      neonClient.deleteDatabase(projectId, neonDatabaseName),
    );
  } catch (err) {
    if (!isAlreadyGone(err)) throw err;
    return { mode: 'legacy', projectId, databaseName: neonDatabaseName, alreadyGone: true, ...degradedFlag };
  }
  return { mode: 'legacy', projectId, databaseName: neonDatabaseName, alreadyGone: false, ...degradedFlag };
}
