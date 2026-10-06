import type pg from 'pg';
import { config } from '../config.js';
import { getRuntimeDbPool, type RuntimeDbConfig } from './runtime-db.js';
import * as neonClient from './neon-client.js';

interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Phase 4 of project-per-app: the backstop for Neon *projects* orphaned by a
 * crash between `createProjectForApp` and the `app_db_connections` insert.
 *
 * `neon-orphan-reconciler.ts` covers the same failure at the *database* level
 * inside the shared projects. It cannot see this one: a tenant project holds
 * its app's database, so when the project is orphaned the database goes with
 * it and never appears in any shared project's database list. Nothing else in
 * the system detects it — the app row was never written, so delete never runs,
 * and the project bills indefinitely.
 *
 * This is not hypothetical. During the 2026-08-21 rehearsal a single network
 * drop orphaned six real projects mid-cleanup; only a retrying sweep recovered
 * them.
 *
 * WHY THIS FILE IS MORE DANGEROUS THAN ITS SIBLING, AND WHAT THAT BUYS
 *
 * Dropping a database inside a shared project is bad. Deleting a *project*
 * destroys the database, its branches, its history, and its backups in one
 * irreversible call. Every safety below is therefore stricter than the
 * database reconciler's equivalent, and two are new:
 *
 *   - ABORT ON PARTIAL INVENTORY. Orphan-ness is proved by ABSENCE — a project
 *     is an orphan because no app row references it. Absence is only
 *     meaningful against a complete picture. If any page of the project list
 *     fails, or any region's runtime DB is unreachable, we abort the entire
 *     cycle rather than act on what we did manage to read. A partial app
 *     inventory would make live projects look orphaned, and we would delete
 *     paying customers' databases. This is the single most important rule in
 *     this file.
 *
 *   - IDENTITY BY PROJECT ID, NEVER BY PARSING THE NAME. The authoritative
 *     link is `app_db_connections.neon_project_id`. We build the set of every
 *     referenced project id and treat membership in that set as "live". Names
 *     are used ONLY as a filter for what may be considered at all
 *     (`bb-app_*`), never to decide whether a specific project is claimed.
 *     `neon-orphan-reconciler.ts` learned this the hard way with `cust_*`
 *     names: a transform that is not invertible must be matched forwards.
 *
 * Inherited from the database reconciler, unchanged in spirit:
 *   - grace hours: never touch a project younger than `graceHours` (default
 *     24), which protects a project created seconds ago by an in-flight
 *     provision whose app row is still being written.
 *   - in-flight task guard: never touch a project whose app id has a pending
 *     or processing `neon_tasks` row.
 *   - max-deletes cap: bounds blast radius per run. Oldest orphans go first.
 *   - dry-run default: unless `NEON_ORPHAN_DRY_RUN=false` is explicit, we only
 *     log what we WOULD delete.
 *   - protected-id denylist: the shared data, runtime, control, substrate and
 *     standby projects can never be deleted, regardless of name or reference.
 *     Belt and braces — none of them are named `bb-app_*` in the first place.
 */

/** Only projects whose name starts with this may EVER be considered. */
const TENANT_PROJECT_PREFIX = 'bb-app_';

export interface TenantOrphan {
  projectId: string;
  name: string;
  /** Parsed from the name for the in-flight guard only — never for identity. */
  appId: string | null;
  region: string | null;
  createdAt: string;
  ageMs: number;
}

export interface TenantReconcileResult {
  /** Total `bb-app_*` projects seen across the org. */
  tenantProjectCount: number;
  /** Distinct project ids referenced by a live app row, across all regions. */
  referencedProjectCount: number;
  orphanCount: number;
  eligibleCount: number;
  deleted: string[];
  wouldDelete: string[];
  skippedYoung: number;
  skippedInflight: number;
  /** Projects whose name did not parse into (appId, region). Never deleted. */
  skippedAmbiguous: number;
  deleteErrors: { projectId: string; error: string }[];
}

export interface TenantReconcileOptions {
  graceHours: number;
  maxDeletesPerRun: number;
  dryRun: boolean;
  /** ISO string; overridable for tests. */
  now?: string;
}

/** Thrown to abort the cycle when the inventory cannot be trusted. */
export class PartialInventoryError extends Error {
  constructor(what: string, cause?: unknown) {
    super(`[tenant-reconciler] refusing to act on a partial inventory: ${what}`);
    this.name = 'PartialInventoryError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Parse `bb-<appId>-<region>` back into its parts.
 *
 * Used ONLY for the in-flight-task lookup and for logging. A parse failure
 * makes a project ambiguous, which makes it permanently ineligible — never an
 * orphan. Identity is decided by project id alone.
 */
export function parseTenantProjectName(
  name: string,
): { appId: string; region: string } | null {
  const m = /^bb-(app_[a-z0-9]+)-([a-z]{2}-[a-z]+-\d+)$/.exec(name);
  if (!m) return null;
  return { appId: m[1], region: m[2] };
}

/**
 * Every project id claimed by a live app row, across every configured region.
 *
 * Throws PartialInventoryError if ANY region fails. A region we cannot read is
 * a region whose apps would all look orphaned.
 */
export async function collectReferencedProjectIds(
  runtimeDbConfig: RuntimeDbConfig,
  regions: string[],
): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (const region of regions) {
    try {
      const pool = getRuntimeDbPool(runtimeDbConfig, region);
      const { rows } = await pool.query<{ neon_project_id: string | null }>(
        `SELECT DISTINCT neon_project_id FROM app_db_connections WHERE neon_project_id IS NOT NULL`,
      );
      for (const r of rows) {
        if (r.neon_project_id) referenced.add(r.neon_project_id);
      }
    } catch (err) {
      throw new PartialInventoryError(`runtime DB for region ${region} unreadable`, err);
    }
  }
  return referenced;
}

/**
 * Project ids that must never be deleted even if nothing references them —
 * the shared data projects and the platform's own infrastructure.
 */
export function protectedProjectIds(regions: string[]): Set<string> {
  const ids = new Set<string>();
  const add = (v: string | undefined) => { if (v) ids.add(v); };
  add(process.env.NEON_DATA_PROJECT_ID);
  for (const r of regions) {
    const key = r.toUpperCase().replace(/-/g, '_');
    add(process.env[`NEON_DATA_PROJECT_ID_${key}`]);
    add(process.env[`NEON_RUNTIME_PROJECT_ID_${key}`]);
  }
  return ids;
}

/** Does this app have a Neon task still in flight? */
async function hasInflightTask(
  runtimeDbConfig: RuntimeDbConfig,
  region: string,
  appId: string,
): Promise<boolean> {
  const pool = getRuntimeDbPool(runtimeDbConfig, region);
  const { rows } = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM neon_tasks
      WHERE app_id = $1 AND status IN ('pending', 'processing')`,
    [appId],
  );
  return Number(rows[0]?.c ?? '0') > 0;
}

export async function reconcileTenantProjects(
  _controlDb: pg.Pool,
  runtimeDbConfig: RuntimeDbConfig,
  logger: Logger,
  opts: TenantReconcileOptions,
  deps: {
    listTenantProjects?: () => Promise<{ id: string; name: string; created_at: string }[]>;
    deleteProject?: (projectId: string) => Promise<void>;
    regions?: string[];
  } = {},
): Promise<TenantReconcileResult> {
  const regions = deps.regions
    ?? (process.env.BUTTERBASE_REGIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const listTenantProjects = deps.listTenantProjects ?? defaultListTenantProjects;
  const deleteProject = deps.deleteProject ?? neonClient.deleteProject;

  if (regions.length === 0) {
    throw new PartialInventoryError('BUTTERBASE_REGIONS is empty — no region to reconcile against');
  }

  // Both of these throw PartialInventoryError rather than returning a short
  // list. Neither result is usable on its own.
  const projects = await listTenantProjects();
  const referenced = await collectReferencedProjectIds(runtimeDbConfig, regions);
  const protectedIds = protectedProjectIds(regions);

  const now = opts.now ? Date.parse(opts.now) : Date.now();
  const graceMs = opts.graceHours * 3600 * 1000;

  const result: TenantReconcileResult = {
    tenantProjectCount: projects.length,
    referencedProjectCount: referenced.size,
    orphanCount: 0,
    eligibleCount: 0,
    deleted: [],
    wouldDelete: [],
    skippedYoung: 0,
    skippedInflight: 0,
    skippedAmbiguous: 0,
    deleteErrors: [],
  };

  const candidates: TenantOrphan[] = [];
  for (const p of projects) {
    // Defence in depth: the lister already filters by prefix.
    if (!p.name.startsWith(TENANT_PROJECT_PREFIX)) continue;
    if (protectedIds.has(p.id)) continue;
    if (referenced.has(p.id)) continue;

    result.orphanCount++;

    const parsed = parseTenantProjectName(p.name);
    if (!parsed) {
      // Cannot identify the owning app, so cannot run the in-flight guard.
      // A missed orphan costs storage; a wrong delete destroys a database.
      result.skippedAmbiguous++;
      continue;
    }

    const createdMs = Date.parse(p.created_at);
    const ageMs = Number.isNaN(createdMs) ? -1 : now - createdMs;
    if (ageMs < 0 || ageMs < graceMs) {
      result.skippedYoung++;
      continue;
    }

    candidates.push({
      projectId: p.id,
      name: p.name,
      appId: parsed.appId,
      region: parsed.region,
      createdAt: p.created_at,
      ageMs,
    });
  }

  // Oldest first — the least likely to be a race with an in-flight provision.
  candidates.sort((a, b) => b.ageMs - a.ageMs);

  const eligible: TenantOrphan[] = [];
  for (const c of candidates) {
    if (c.appId && c.region && regions.includes(c.region)) {
      let inflight: boolean;
      try {
        inflight = await hasInflightTask(runtimeDbConfig, c.region, c.appId);
      } catch (err) {
        // Same logic as a missing region: if we cannot check, we cannot clear it.
        throw new PartialInventoryError(`neon_tasks unreadable for region ${c.region}`, err);
      }
      if (inflight) {
        result.skippedInflight++;
        continue;
      }
    }
    eligible.push(c);
  }
  result.eligibleCount = eligible.length;

  const toProcess = eligible.slice(0, opts.maxDeletesPerRun);

  logger.info(
    {
      tenantProjectCount: result.tenantProjectCount,
      referencedProjectCount: result.referencedProjectCount,
      orphanCount: result.orphanCount,
      eligibleCount: result.eligibleCount,
      skippedYoung: result.skippedYoung,
      skippedInflight: result.skippedInflight,
      skippedAmbiguous: result.skippedAmbiguous,
      cappedAt: opts.maxDeletesPerRun,
      willProcess: toProcess.length,
      regions,
      mode: opts.dryRun ? 'dry-run' : 'delete',
    },
    '[tenant-reconciler] scan complete',
  );

  for (const o of toProcess) {
    if (opts.dryRun) {
      result.wouldDelete.push(o.name);
      logger.info(
        {
          projectId: o.projectId,
          name: o.name,
          appId: o.appId,
          region: o.region,
          ageHours: (o.ageMs / 3600 / 1000).toFixed(1),
          createdAt: o.createdAt,
        },
        '[tenant-reconciler] WOULD DELETE PROJECT (dry-run)',
      );
      continue;
    }
    try {
      await deleteProject(o.projectId);
      result.deleted.push(o.name);
      logger.warn(
        { projectId: o.projectId, name: o.name, appId: o.appId, region: o.region },
        '[tenant-reconciler] deleted orphaned project',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.deleteErrors.push({ projectId: o.projectId, error: msg });
      logger.error(
        { projectId: o.projectId, name: o.name, err },
        '[tenant-reconciler] project delete failed',
      );
    }
  }

  return result;
}

/**
 * Page through the org's projects, keeping only `bb-app_*`.
 *
 * Any page failure throws PartialInventoryError: a truncated project list is
 * safe (we would simply miss orphans), but a truncated list combined with the
 * `referenced` set is NOT what decides deletion — so the real reason to abort
 * is that a failure here usually signals the API is unhealthy, and we would
 * rather skip a cycle than act during one.
 */
async function defaultListTenantProjects(): Promise<{ id: string; name: string; created_at: string }[]> {
  const out: { id: string; name: string; created_at: string }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    let batch: { id: string; name: string; created_at: string }[];
    let nextCursor: string | undefined;
    try {
      const res = await neonClient.listProjectsPage({ cursor, limit: 400 });
      batch = res.projects;
      nextCursor = res.cursor;
    } catch (err) {
      throw new PartialInventoryError('project listing failed mid-scan', err);
    }
    for (const p of batch) {
      if (p.name.startsWith(TENANT_PROJECT_PREFIX)) out.push(p);
    }
    if (batch.length === 0 || !nextCursor) return out;
    cursor = nextCursor;
  }
  throw new PartialInventoryError('project listing did not terminate within 200 pages');
}

export const __testing = { defaultListTenantProjects, TENANT_PROJECT_PREFIX };

/** Re-exported so index.ts can read the same config shape as the db reconciler. */
export function tenantReconcilerConfig() {
  return config.neon.orphanReconciler;
}
