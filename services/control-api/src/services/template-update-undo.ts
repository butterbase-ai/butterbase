import pg from 'pg';
import type { AppStateManifest, CapturedFunction } from './app-state-capture.js';
import type { PreSyncLineage } from './clone-jobs.js';

export interface UndoLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

/**
 * Restore a fork's function bodies to the state captured before an update ran.
 *
 * Symmetric with replayFunctions: functions live entirely in `app_functions`
 * (the runtime reads the row at invoke time), so putting the pre-update `code`
 * back is the same class of write the update itself made — no build, no deploy,
 * no S3.
 *
 * Two halves, and both are needed for the fork to read as unmodified again.
 * decideEligibility gates on repo AND functions, and computeDivergence compares
 * captureAppState's `functions` hash against base_fingerprint. Restoring bodies
 * but leaving the functions the release ADDED in place would leave that hash
 * different from the restored fingerprint, i.e. exactly the "modified" trap
 * undo exists to escape.
 *
 * `templateFunctionNames` is what makes the removal half safe. A function
 * present now but absent from the pre-update manifest is either one the update
 * inserted or one the owner wrote afterwards; only the former appears in the
 * target release's manifest, and only the former is removed. An owner's new
 * function is never touched.
 *
 * Removal is a soft delete (`deleted_at`), the same mechanism the functions
 * routes use, so nothing is destroyed — and `deleted_at = NULL` in the restore
 * upsert below means a fork whose function was soft-deleted mid-update comes
 * back rather than staying invisible behind the (app_id, name) unique key.
 *
 * Known limitation: captureAppState folds a function down to ONE trigger (the
 * alphabetically first). A function that had several keeps the others as they
 * are; only the captured one is restored.
 */
export async function restoreFunctionsFromManifest(
  runtimePool: pg.Pool,
  appId: string,
  manifest: AppStateManifest,
  templateFunctionNames: ReadonlySet<string>,
  restoredByUserId: string,
  logger: UndoLogger,
): Promise<{ restored: number; removed: number; warnings: string[] }> {
  const warnings: string[] = [];
  const fns: CapturedFunction[] = manifest.functions ?? [];
  let restored = 0;

  for (const f of fns) {
    try {
      const res = await runtimePool.query<{ id: string; inserted: boolean }>(
        `INSERT INTO app_functions (
           id, app_id,
           name, code, description,
           timeout_ms, memory_limit_mb,
           agent_tool, agent_tool_description, agent_tool_mode, agent_tool_exposed_to,
           deployed_by, deployed_at
         ) VALUES (
           gen_random_uuid(), $1,
           $2, $3, $4,
           $5, $6,
           $7, $8, $9, $10,
           $11, now()
         )
         ON CONFLICT (app_id, name) DO UPDATE SET
           code = EXCLUDED.code,
           description = EXCLUDED.description,
           timeout_ms = EXCLUDED.timeout_ms,
           memory_limit_mb = EXCLUDED.memory_limit_mb,
           agent_tool = EXCLUDED.agent_tool,
           agent_tool_description = EXCLUDED.agent_tool_description,
           agent_tool_mode = EXCLUDED.agent_tool_mode,
           agent_tool_exposed_to = EXCLUDED.agent_tool_exposed_to,
           deleted_at = NULL,
           deployed_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [
          appId, f.name, f.code, f.description,
          f.timeout_ms, f.memory_limit_mb,
          f.agent_tool, f.agent_tool_description, f.agent_tool_mode, f.agent_tool_exposed_to,
          restoredByUserId,
        ],
      );
      const row = res.rows[0];
      if (!row) {
        warnings.push(`function ${f.name}: restore returned no row`);
        continue;
      }
      // The row is normally already there — an update overwrites bodies, it
      // never removes functions. A true INSERT means the row went missing, and
      // env var VALUES are never captured in a manifest, so the recreated
      // function has none. Say so rather than hand back a function that 500s
      // on its first secret read.
      if (row.inserted === true) {
        warnings.push(
          `function ${f.name} had to be recreated; its environment variables were not restored ` +
            '(manifests never carry secret values). Set them again before invoking it.',
        );
      }
      await runtimePool.query(
        `INSERT INTO function_triggers (function_id, app_id, trigger_type, trigger_config, enabled)
              VALUES ($1, $2, $3, $4::jsonb, true)
         ON CONFLICT (function_id, trigger_type) DO UPDATE SET
           trigger_config = EXCLUDED.trigger_config`,
        [row.id, appId, f.trigger_type ?? 'http', JSON.stringify(f.trigger_config ?? {})],
      );
      restored++;
    } catch (err) {
      warnings.push(`function ${f.name}: ${(err as Error).message}`);
      logger.warn({ err, appId, fn: f.name }, '[update-undo] function restore failed');
    }
  }

  const keep = fns.map((f) => f.name);
  const removable = [...templateFunctionNames].filter((n) => !keep.includes(n));
  let removed = 0;
  if (removable.length > 0) {
    const res = await runtimePool.query(
      `UPDATE app_functions SET deleted_at = now()
        WHERE app_id = $1 AND deleted_at IS NULL AND name = ANY($2::text[])`,
      [appId, removable],
    );
    removed = res.rowCount ?? 0;
  }

  logger.info({ appId, restored, removed, warnings: warnings.length }, '[update-undo] functions restored');
  return { restored, removed, warnings };
}

/**
 * Put the fork's lineage anchor back where it was before the update.
 *
 * This is the write that actually un-bricks the fork. Without it the fork's
 * base_snapshot_id still names the release's snapshot while its repo HEAD has
 * been rolled back, so computeDivergence reports repo: true and
 * decideEligibility returns 'modified' forever.
 *
 * Deliberately restores all three fields together in one statement, including
 * NULLs: a fork cloned from a live template legitimately has base_release_id
 * NULL and base_fingerprint set, and writing only the non-null ones would
 * fabricate a lineage the fork never had.
 */
export async function restoreLineage(
  controlDb: pg.Pool,
  forkAppId: string,
  pre: PreSyncLineage,
): Promise<void> {
  await controlDb.query(
    `UPDATE app_lineage
        SET base_release_id  = $1,
            base_snapshot_id = $2,
            base_fingerprint = $3::jsonb
      WHERE dest_app_id = $4`,
    [
      pre.base_release_id,
      pre.base_snapshot_id,
      pre.base_fingerprint ? JSON.stringify(pre.base_fingerprint) : null,
      forkAppId,
    ],
  );
}

/** Function names the target release carries — the only ones undo may remove. */
export async function templateFunctionNamesForRelease(
  controlDb: pg.Pool,
  releaseId: string | null,
): Promise<Set<string>> {
  if (!releaseId) return new Set();
  const res = await controlDb.query<{ manifest: AppStateManifest | null }>(
    `SELECT manifest FROM template_releases WHERE id = $1`, [releaseId],
  );
  const fns = res.rows[0]?.manifest?.functions ?? [];
  return new Set(fns.map((f) => f.name));
}

/**
 * May this job be undone?
 *
 * `failed` is included on purpose, and it is the whole point of the second
 * clause. executeUpdate replaces the repo BEFORE it replays schema, functions
 * and config and long before it advances lineage, so a failure in any of those
 * later steps leaves the fork with the template's code and its own old lineage
 * — reading as modified, refused by POST /update (422), refused by retry after
 * an hour, and previously refused by undo too because the job was not
 * 'completed'. All three exits closed on a live app. Undo is the escape, so it
 * must be open here.
 *
 * `pending` and `processing` stay refused: a worker may be mid-write, and
 * restoring underneath it would race.
 *
 * Requires pre-sync state to exist, tested with `=== null` rather than
 * falsiness, so an empty string never reads as "nothing recorded".
 */
export function canUndoUpdateJob(job: {
  status: string;
  pre_sync_snapshot_id: string | null;
  pre_sync_lineage: PreSyncLineage | null;
}): { allowed: boolean; reason: 'ok' | 'not_terminal' | 'no_pre_sync_state' } {
  if (job.status !== 'completed' && job.status !== 'failed') {
    return { allowed: false, reason: 'not_terminal' };
  }
  if (job.pre_sync_snapshot_id === null && job.pre_sync_lineage === null) {
    return { allowed: false, reason: 'no_pre_sync_state' };
  }
  return { allowed: true, reason: 'ok' };
}
