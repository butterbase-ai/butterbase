import type pg from 'pg';
import { getEnvironmentLink, touchEnvironmentTimestamp } from './app-environments.js';
import { replaySeedData } from './clone-replay.js';
import { reconcileStagingSchema } from './staging-schema-reconcile.js';
import { isolateStagingApp, isolateStagingMeetingsWebhook } from './staging-isolation.js';
import {
  enqueueStagingDataCopy, enqueueCopyWaitTask, COPY_POLL_INTERVAL_MS,
} from './staging-data-copy.js';
import {
  setCloneJobStatus, createCloneJob, appendCloneJobWarnings, type CloneJob,
} from './clone-jobs.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { getActivePromoteJob } from './promote-jobs.js';
import { EXCLUDED_TABLES, introspectSchema } from './schema-introspector.js';

export interface ResetLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface ResetDeps {
  /** Control-tier pool: template_clone_jobs lives here. */
  controlDb: pg.Pool;
  /**
   * Regional runtime pool. `apps` and `app_environments` are both
   * runtime-tier tables, and staging is pinned to production's region
   * (start-staging.ts), so ONE pool serves both apps here.
   */
  runtimeDb: pg.Pool;
  /** Per-app database of the PRODUCTION app — the source of the re-seed. */
  prodPool: pg.Pool;
  /** Per-app database of the STAGING app — the destination of the re-seed. */
  stagingPool: pg.Pool;
  /**
   * The staging app's `apps.db_name`. Checked against `SELECT
   * current_database()` on `stagingPool` immediately before the TRUNCATE —
   * see truncateStagingAppTables's Guard 3. Every other guard compares
   * values chosen upstream of the pool-resolution call (ids, object
   * identity); this one asks the one question that actually matters, which
   * physical database the connection is pointed at, so it is the only guard
   * that still catches a swapped `getAppPoolForApp` call at the wrapper in
   * neon-task-worker.ts.
   */
  stagingDbName: string;
  /**
   * The neon_tasks attempt counters for this run (`task.attempts` /
   * `task.max_attempts`). Decide whether a failure is permanent — see the
   * catch block, which mirrors executePromote's / executeUpdate's retry
   * contract: 'failed' is written only once the queue has exhausted its
   * attempts, so a transient blip on attempt 1 of N does not turn the
   * remaining attempts into silent no-ops (isTerminalCloneStatus
   * short-circuits any resumed job whose status is already terminal).
   */
  attempt: number;
  maxAttempts: number;
  logger: ResetLogger;
  /**
   * The region both apps live in. Staging is pinned to production's region at
   * admission (start-staging.ts), so one value is correct for both sides - it
   * is the queue the copy-wait task is armed on, and the region written onto
   * the app_copy_jobs row.
   *
   * OPTIONAL, and the whole production-data-copy step is skipped when it is
   * absent. The precedent on this branch (preserveDestinationTriggerEnabled,
   * warnOnZeroRewrite, throwOnFailure, skipIntegrations) is that a change to
   * shared clone machinery is additive and opt-in with byte-identical
   * defaults; an existing caller or test that constructs ResetDeps without
   * this field therefore gets exactly today's truncate-and-reseed behaviour.
   */
  region?: string;
}

export async function startStagingReset(args: {
  controlDb: pg.Pool; prodAppId: string; userId: string; orgId: string;
}): Promise<
  | { ok: true; jobId: string; stagingAppId: string }
  | { ok: false; code: 'NO_STAGING'; message: string }
  | { ok: false; code: 'IN_FLIGHT'; message: string }
> {
  const { controlDb, prodAppId, userId, orgId } = args;

  // Cheap check first, before any runtime-tier round trip — mirrors
  // startPromote's own IN_FLIGHT precheck (promote-jobs.ts), in the other
  // direction. A reset that truncates staging's seed tables while a promote
  // is reading them mid-flight would let that promote silently copy a
  // partial (post-truncate) dataset onto production and still report
  // 'completed' — production isn't corrupted (replaySeedData is
  // insert-only, so no production row is ever destroyed), but the job's
  // success status would be a lie about what actually landed. That
  // silent-wrong-answer shape is exactly what this feature's other guards
  // (Task 13's RLS/trigger disclosures, this task's own cascade warning)
  // exist to eliminate, so refuse rather than let it happen.
  //
  // This is a precheck, not an atomic guarantee — like startPromote's own
  // IN_FLIGHT check, it is a read-then-later-write with a gap a genuinely
  // concurrent request could still slip through. No dedicated unique index
  // guards reset-vs-promote the way idx_template_clone_jobs_one_promote
  // guards promote-vs-promote: that would need an index keyed on the
  // (prod_app_id, staging_app_id) PAIR rather than a single column, since a
  // promote's dest_app_id is production while a reset's dest_app_id is
  // staging — a materially bigger schema change than this fix round
  // warrants for a narrow, already-mostly-closed race window. Recorded here
  // rather than silently deferred.
  if (await getActivePromoteJob(controlDb, prodAppId)) {
    return {
      ok: false,
      code: 'IN_FLIGHT',
      message: 'A promote is currently running for this app. Wait for it to finish before '
        + 'resetting staging.',
    };
  }

  // getRuntimeDbForApp returns the regional pg.Pool directly (not
  // { pool, region }) — region-resolver.ts. The region string itself is
  // fetched separately below via the apps row, matching startPromote's
  // pattern in promote-jobs.ts.
  const runtimeDb = await getRuntimeDbForApp(controlDb, prodAppId);

  // This also naturally refuses a reset against a half-provisioned
  // staging_create: finalizeStagingClone (staging-completion.ts) only calls
  // linkEnvironments — the write getEnvironmentLink reads here — AFTER
  // isolation, at the very end of executeClone. Until a staging_create job
  // finishes, there is no app_environments row for this prod app yet, so
  // this NO_STAGING branch already catches it without a dedicated
  // in-flight-staging_create precheck.
  const link = await getEnvironmentLink(runtimeDb, prodAppId);
  if (!link) {
    return {
      ok: false,
      code: 'NO_STAGING',
      message: 'This app has no staging environment to reset.',
    };
  }

  const prodRow = (
    await runtimeDb.query<{ region: string }>(
      `SELECT region FROM apps WHERE id = $1`, [prodAppId],
    )
  ).rows[0];
  if (!prodRow) {
    return { ok: false, code: 'NO_STAGING', message: 'Production app not found.' };
  }

  // Direction: sourceAppId is the PRODUCTION app, matching job.source_app_id
  // for every reset job (see executeStagingReset below and
  // resolveCloneDispatch's routing in neon-task-worker.ts). This is the
  // opposite of startPromote, whose source is the staging app — reset flows
  // production -> staging, every other clone-family job flows the other way.
  // source_snapshot_id is deliberately NULL: a reset never touches the repo
  // (no 'repo'/'frontend' step exists in executeStagingReset), so there is
  // nothing real to pin, and the column has allowed NULL since migration 117.
  const job = await createCloneJob(controlDb, {
    sourceAppId: prodAppId,
    sourceSnapshotId: null,
    sourceRegion: prodRow.region,
    destRegion: prodRow.region,
    requestedByUserId: userId,
    destOrganizationId: orgId,
  });

  // createCloneJob's INSERT does not set mode or dest_app_id (both default:
  // mode='clone', dest_app_id=NULL) — same follow-up UPDATE shape as
  // startPromote (promote-jobs.ts) and start-staging.ts. dest_app_id is the
  // STAGING app: reset writes onto staging, never onto the production
  // source.
  await controlDb.query(
    `UPDATE template_clone_jobs SET mode = 'staging_reset', dest_app_id = $2 WHERE id = $1`,
    [job.id, link.staging_app_id],
  );

  return { ok: true, jobId: job.id, stagingAppId: link.staging_app_id };
}

/**
 * THE THREE GUARDS, in one place, callable immediately before every
 * destructive statement a reset issues.
 *
 * A reset now runs TWO kinds of destructive SQL against staging — the
 * `TRUNCATE ... CASCADE`, and (since the destructive-reconcile ruling) `DROP
 * TABLE` / `DROP COLUMN` / `ALTER COLUMN ... TYPE` from
 * reconcileStagingSchema. Aimed at the wrong pool, either one destroys a
 * customer's PRODUCTION database unrecoverably. They were previously inline in
 * truncateStagingAppTables, which meant the new DDL would have executed with
 * no protection at all; extracting them is what lets both hazards be guarded
 * by the same three checks rather than by one copy each that can drift.
 *
 *   1. stagingAppId === prodAppId is refused — on a reset job these must
 *      always differ (source_app_id is production, dest_app_id is staging).
 *      If they were ever equal, something upstream (startStagingReset,
 *      resolveCloneDispatch's routing, or the CloneJob row itself) is broken,
 *      and the only safe response is to fail loudly before running any SQL.
 *   2. stagingPool === prodPool (reference equality) is refused — this catches
 *      a pool-resolution bug (e.g. getAppPoolForApp's cache keyed wrong) that
 *      the id check above cannot see, since two different app ids could resolve
 *      to the same pool object if the caching key were ever wrong.
 *   3. `SELECT current_database()` on stagingPool must equal the caller-
 *      supplied `stagingDbName`. Guards 1 and 2 both compare values chosen
 *      UPSTREAM of the getAppPoolForApp call in neon-task-worker.ts's
 *      executeResetTask — if that call's two `pg.Pool` assignments were ever
 *      swapped (i.e. `prodPool` gets the app id/db_name that actually belong to
 *      staging, and vice versa), both ids would still differ and both pool
 *      objects would still be distinct, so guards 1 and 2 would both pass while
 *      the destructive statement ran against production. Guard 3 is the only
 *      one that asks the LIVE CONNECTION instead of a value threaded through
 *      arguments, so it is the only one that still catches that swap. It is a
 *      round trip, and it is worth one per hazard.
 *
 * Call this immediately before the hazard, never once at the top of the reset:
 * the distance between the check and the statement is the whole point.
 */
async function assertStagingTarget(args: {
  prodAppId: string;
  stagingAppId: string;
  prodPool: pg.Pool;
  stagingPool: pg.Pool;
  stagingDbName: string;
  /** Names the operation in the refusal message ('truncate', 'alter schema'). */
  action: string;
}): Promise<void> {
  const { prodAppId, stagingAppId, prodPool, stagingPool, stagingDbName, action } = args;

  // Guard 1: id-level.
  if (stagingAppId === prodAppId) {
    throw new Error(
      `[staging-reset] refusing to ${action}: dest_app_id (staging, ${stagingAppId}) equals `
        + `source_app_id (production, ${prodAppId})`,
    );
  }
  // Guard 2: pool-identity level.
  if (stagingPool === prodPool) {
    throw new Error(
      `[staging-reset] refusing to ${action}: the staging pool is reference-identical to the `
        + 'production pool',
    );
  }
  // Guard 3: connection-level.
  const dbCheck = await stagingPool.query<{ current_database: string }>(
    'SELECT current_database()',
  );
  const connectedDb = dbCheck.rows[0]?.current_database;
  if (connectedDb !== stagingDbName) {
    throw new Error(
      `[staging-reset] refusing to ${action}: staging pool for app ${stagingAppId} is connected `
        + `to database "${connectedDb}", expected "${stagingDbName}"`,
    );
  }
}

/**
 * Empties the staging app's data tables before production's rows are copied
 * back in.
 *
 * WITHOUT THIS, A RESET IS A NO-OP FOR EVERY ROW STAGING ALREADY HAD. Both
 * repopulating engines are purely additive — replaySeedData issues
 * `INSERT ... ON CONFLICT DO NOTHING`, and so does the app-copy engine's data
 * phase — so any row already present in staging (which is the entire reason
 * anyone runs a reset: staging has drifted) survives with its stale staging
 * value, and a row that exists only in staging survives outright.
 * `manage_staging`'s tool text promises callers reset "discards the staging
 * app's data"; this is what makes that true.
 *
 * WHICH TABLES. Every user table on the staging database, via
 * `introspectSchema` — NOT the `_seed_tables` registry this used to read.
 *
 * The earlier derivation ("truncate the table set replaySeedData re-seeds,
 * derived the same way") rested on a premise that is false for essentially
 * every real app: `_seed_tables` is populated only from DSL tables carrying a
 * `_seed: true` flag, so for a normal app it is EMPTY, this function logged
 * "nothing to truncate", and reset silently degraded to an additive merge. It
 * was never caught because every unit test stubbed `getSeedTableNames` to
 * return names, so the empty case — the only case that occurs in production —
 * had no coverage at all.
 *
 * The honest table set is the one the thing that repopulates staging will
 * actually write to. That is the app-copy engine's plan (`buildCopyPlan` in
 * the app-copy overlay), and its table list comes from
 * `deps.introspect` — which IS this module's `introspectSchema`. Control-api
 * cannot import `buildCopyPlan` (the dependency runs overlay -> control-api
 * and never the reverse, see staging-data-copy.ts), but it can and does call
 * the identical introspection, with the identical `EXCLUDED_TABLES` filter, so
 * the two sets are derived from one function rather than from two that can
 * drift. `topo-sort.ts`'s FK ordering, which the plan also carries, is not
 * needed here: one multi-table `TRUNCATE ... CASCADE` makes Postgres resolve
 * the ordering itself.
 *
 * Read from STAGING, not production, and therefore a SUPERSET of what the copy
 * refills: a table that exists only on staging is emptied too. That is
 * deliberate and inside the contract — reset is "discard the staging app's
 * data", and a staging-only table is staging data — and it is named on the job
 * (see executeStagingReset's not-repopulated warning) rather than left for the
 * user to discover.
 *
 * THREE INDEPENDENT GUARDS before the TRUNCATE runs, because a TRUNCATE aimed
 * at the wrong pool destroys a customer's PRODUCTION data, unrecoverably —
 * this is exactly as dangerous as the replaySeedData argument-order hazard
 * documented on executeStagingReset below, just on the truncate side instead
 * of the insert side. The three checks themselves now live in
 * `assertStagingTarget` above — shared, unchanged, with the destructive schema
 * reconcile, which issues DROP TABLE / DROP COLUMN / ALTER COLUMN ... TYPE
 * against the same pool and therefore needs exactly the same protection at
 * exactly the same distance.
 *
 * They run TWICE in this function: once before the cascade introspection, and
 * once immediately before the TRUNCATE statement itself. That is not
 * redundancy — Guard 3 asks what the LIVE CONNECTION is pointed at, and other
 * queries run in between.
 *
 * `introspectSchema` already excludes schema-introspector.ts's
 * `EXCLUDED_TABLES` (Butterbase's own per-app bookkeeping: `_rag_*`,
 * `_idempotency_keys`, the migration-tracking tables, `_seed_tables` itself).
 * The list is filtered against it a second time here — belt-and-suspenders,
 * and structural rather than emergent: this file's own invariant is "never
 * truncate our own bookkeeping tables", and it must stay true even if
 * introspectSchema's own exclusion ever moves.
 *
 * Runs ONE `TRUNCATE ... CASCADE` over the whole list rather than a
 * table-by-table DELETE, so Postgres resolves foreign-key ordering itself —
 * this is why the plan's topo-sort is not replicated here. CASCADE is kept
 * even though the list is now every user table, because the only thing left
 * outside the list is Butterbase's own bookkeeping (`_rag_*`,
 * `_idempotency_keys`, `_data_plane_migrations`, `_ai_migrations`,
 * `_seed_tables`), and the Task 16 fix-round-1 schema audit established that
 * none of those carries a foreign key into an app-defined table — so CASCADE
 * has nothing outside the list to reach in practice.
 *
 * STANDING RULE (fifth time this feature has needed it — see Task 11's
 * ignoredRemovals, Task 13's surfaced RLS policies and disabled-trigger
 * disclosure, Task 14's zero-rewrite and Pages-still-building warnings): do
 * the conservative thing, then name it. CASCADE reaching a table outside the
 * truncate list is exactly that shape — sweeping it is the right call, but
 * the user must be able to reconstruct what happened from the job record
 * alone, not from server logs they cannot see. Before running the TRUNCATE,
 * this makes a best-effort (non-blocking) attempt to discover which OTHER
 * tables a cascade would reach — via the same foreign-key graph Postgres
 * itself would follow — and appends a job warning naming them if any are
 * found. That should now be empty for every app; it is kept precisely so that
 * "should now be empty" is a thing the job record proves rather than a thing
 * this comment asserts. The discovery query itself must NEVER gate or fail
 * the truncate: a missing warning is not worth failing a reset that otherwise
 * succeeded, so a discovery failure is caught, logged, and the truncate
 * proceeds anyway. Do not "fix" that into a hard failure — a failed
 * introspection query says nothing about whether the TRUNCATE itself would
 * have been safe.
 */
async function truncateStagingAppTables(args: {
  prodAppId: string;
  stagingAppId: string;
  prodPool: pg.Pool;
  stagingPool: pg.Pool;
  stagingDbName: string;
  controlDb: pg.Pool;
  jobId: string;
  logger: ResetLogger;
}): Promise<{ tables: string[] }> {
  const {
    prodAppId, stagingAppId, prodPool, stagingPool, stagingDbName, controlDb, jobId, logger,
  } = args;

  // All three guards, immediately before the TRUNCATE's own introspection and
  // re-run once more right before the TRUNCATE statement itself (below). See
  // assertStagingTarget.
  await assertStagingTarget({
    prodAppId, stagingAppId, prodPool, stagingPool, stagingDbName, action: 'truncate',
  });

  // THE SAME INTROSPECTION THE APP-COPY PLAN USES (buildCopyPlan's
  // deps.introspect IS this function) — see the doc comment for why the
  // `_seed_tables` registry this used to read was the wrong source.
  const stagingSchema = await introspectSchema(stagingPool);
  const rawTables = Object.keys(stagingSchema.tables);
  // See the function doc comment on why this filter exists even though
  // introspectSchema already applies it: structural, not emergent.
  const tables = rawTables.filter((t) => !EXCLUDED_TABLES.includes(t));
  if (tables.length !== rawTables.length) {
    logger.warn(
      {
        stagingAppId,
        excluded: rawTables.filter((t) => EXCLUDED_TABLES.includes(t)),
      },
      '[staging-reset] introspection returned a Butterbase-internal bookkeeping table; excluded '
        + 'it from truncation (this should never happen — see truncateStagingAppTables doc comment)',
    );
  }
  if (tables.length === 0) {
    logger.info(
      { stagingAppId },
      '[staging-reset] staging has no user tables; nothing to truncate',
    );
    return { tables: [] };
  }

  // Best-effort visibility into what CASCADE will touch. Never allowed to
  // block or fail the truncate itself — an introspection query failing (odd
  // permissions, an exotic Postgres version) must not turn a reset into a
  // silent no-op. See the function doc comment: do the conservative thing
  // (sweep it), then name it (job warning), but never gate on being able to
  // name it.
  try {
    const closure = await stagingPool.query<{ table_name: string }>(
      `WITH RECURSIVE targeted(name) AS (
         SELECT unnest($1::text[])
       ), reached AS (
         SELECT name FROM targeted
         UNION
         SELECT c.conrelid::regclass::text AS name
         FROM pg_constraint c
         JOIN reached r ON c.confrelid::regclass::text = r.name
         WHERE c.contype = 'f'
       )
       SELECT DISTINCT name AS table_name FROM reached`,
      [tables],
    );
    const reached = closure.rows.map((r) => r.table_name.split('.').pop() ?? r.table_name);
    const extra = reached.filter((t) => !tables.includes(t));
    if (extra.length > 0) {
      logger.warn(
        { stagingAppId, truncating: tables, cascadeReaches: extra },
        '[staging-reset] TRUNCATE ... CASCADE will also reach tables outside the truncate list',
      );
      // Job-level, not just a log line: the user cannot see server logs, and
      // has to be able to learn from the job record alone that their reset
      // also cleared these tables.
      await appendCloneJobWarnings(controlDb, jobId, [
        `Reset also cleared ${extra.length} ${extra.length === 1 ? 'table' : 'tables'} on `
          + `staging via foreign-key cascade: ${extra.join(', ')}. These sit outside the set of `
          + 'app data tables reset truncates deliberately, and TRUNCATE ... CASCADE swept them '
          + 'along with it.',
      ]);
    }
  } catch (err) {
    // Deliberately non-blocking — see the function doc comment. A failed
    // introspection query says nothing about whether the TRUNCATE itself is
    // safe, so the truncate below still proceeds; only the warning is lost.
    logger.warn(
      { err, stagingAppId },
      '[staging-reset] could not introspect cascade closure before truncating (non-blocking)',
    );
  }

  // Re-run, as close to the hazard as it is possible to get: the cascade
  // introspection above issued queries between the first check and this line,
  // and Guard 3 is specifically about what the LIVE connection is pointed at.
  await assertStagingTarget({
    prodAppId, stagingAppId, prodPool, stagingPool, stagingDbName, action: 'truncate',
  });

  const tableList = tables.map((t) => `"${t}"`).join(', ');
  await stagingPool.query(`TRUNCATE TABLE ${tableList} CASCADE`);
  logger.info(
    { stagingAppId, tables },
    '[staging-reset] truncated staging data tables before re-populating from production',
  );

  return { tables };
}

/**
 * Re-seeds the staging app from production.
 *
 * DIRECTION IS REVERSED FROM PROMOTE. Every other job in this feature flows
 * staging -> production; this one flows production -> staging. On a reset
 * job, job.source_app_id is the PRODUCTION app and job.dest_app_id is the
 * STAGING app — the opposite of a promote job, where source = staging and
 * dest = production. Swapping the two pg.Pool arguments to replaySeedData
 * below would overwrite a customer's LIVE PRODUCTION DATA with staging's —
 * unrecoverable data loss. The assignment below asserts the direction
 * explicitly (not just via argument position) so a future edit cannot
 * silently invert it: prodAppId/stagingAppId are read from named CloneJob
 * fields and the pools passed to replaySeedData are named prodPool/
 * stagingPool from ResetDeps, not renamed or destructured positionally.
 *
 * Never writes to production: no schema/RLS/functions/config/repo/frontend
 * step exists here (contrast execute-promote.ts) — only the staging app's
 * per-app database and the staging isolation tables are touched.
 */
export async function executeStagingReset(deps: ResetDeps, job: CloneJob): Promise<void> {
  const {
    controlDb, runtimeDb, prodPool, stagingPool, stagingDbName, attempt, maxAttempts, logger,
    region,
  } = deps;
  const jobId = job.id;

  // Direction assertion: production is the SOURCE, staging is the
  // DESTINATION. Named explicitly rather than trusting call-site argument
  // order — see the function doc comment above.
  const prodAppId = job.source_app_id;
  const stagingAppId = job.dest_app_id;
  if (!stagingAppId) {
    throw new Error(`Reset job ${jobId} has no dest_app_id (staging app)`);
  }

  // Hard-refuse before touching anything: on a reset job these two ids must
  // always differ. If they were ever equal, something upstream is broken and
  // the correct response is to fail loudly rather than run any SQL — see
  // truncateStagingAppTables's doc comment for why this is checked again,
  // defense-in-depth, right before the TRUNCATE itself. This one is checked
  // even earlier — before the job status is even touched — and is NOT
  // attempt-gated: it is a config invariant, not a transient failure, so
  // retrying it would never succeed.
  if (stagingAppId === prodAppId) {
    const msg = `[staging-reset] refusing to reset: dest_app_id (${stagingAppId}) equals `
      + `source_app_id (production). Job ${jobId} is malformed.`;
    await setCloneJobStatus(controlDb, jobId, {
      status: 'failed', error_message: msg, completed_at: new Date(),
    }).catch(() => {});
    throw new Error(msg);
  }

  // Execution-time re-check, distinct from startStagingReset's request-time
  // IN_FLIGHT precheck. A reset does not run the moment it is requested — it
  // sits in the neon_tasks queue — so the realistic race is not two
  // simultaneous requests, it is: reset queued, THEN a promote starts, THEN
  // this worker finally claims the reset task and is about to truncate the
  // very tables the promote is reading. The request-time precheck cannot see
  // a promote that did not exist yet when it ran. Re-checking here, right
  // before the truncate, closes that window.
  //
  // Permanent failure, not attempt-gated: retrying into the same conflict on
  // the next backoff is pointless (the promote will very likely still be
  // running), and the right recovery is for the user to re-run the reset
  // once the promote finishes — not for the queue to keep silently retrying
  // into it. So this bypasses the attempt-gated catch below entirely, the
  // same way the dest_app_id/source_app_id guard above does.
  if (await getActivePromoteJob(controlDb, prodAppId)) {
    const msg = `[staging-reset] refusing to truncate: a promote is now in flight for `
      + `${prodAppId}; re-run the reset once the promote finishes`;
    await setCloneJobStatus(controlDb, jobId, {
      status: 'failed', error_message: msg, completed_at: new Date(),
    }).catch(() => {});
    throw new Error(msg);
  }

  try {
    await setCloneJobStatus(controlDb, jobId, { status: 'seeding_data' });

    // ROWS OUT FIRST, THEN SCHEMA, THEN ROWS BACK IN.
    //
    // Truncate BEFORE re-populating: both replaySeedData and the app-copy
    // engine's data phase are INSERT ... ON CONFLICT DO NOTHING, so without
    // this step a reset leaves every row staging already had untouched — see
    // truncateStagingAppTables's doc comment.
    await truncateStagingAppTables({
      prodAppId, stagingAppId, prodPool, stagingPool, stagingDbName, controlDb, jobId, logger,
    });

    // SCHEMA AFTER THE TRUNCATE, AND THAT ORDER IS LOAD-BEARING. It is what
    // makes "a reset always succeeds" true rather than merely intended:
    //
    //   - `ALTER COLUMN ... TYPE` on a POPULATED table needs a `USING` clause
    //     and fails outright when no implicit cast exists (`ALTER TABLE notes
    //     ALTER COLUMN body TYPE integer` on text rows is exactly the case the
    //     live smoke test hit). On an EMPTY table it always succeeds, with no
    //     `USING` and no guess about how to reinterpret a customer's values.
    //   - `SET NOT NULL` cannot trip over an existing NULL.
    //   - Dropping a staging-only table costs nothing once its rows are gone,
    //     and its rows were always going to go: reset discards staging's data
    //     by definition.
    //
    // Running the DDL first would mean choosing, on the user's behalf, how to
    // cast rows that the very next statement deletes. Running it second means
    // never having to.
    //
    // Reset's contract is "make staging look like production again", and
    // schema is part of that: the app-copy engine reads production's column
    // list and INSERTs it into staging verbatim, so once staging's schema has
    // diverged every row of the copy fails and the reset job goes to `failed`
    // — permanently, because nothing here reconciled schema, so the state
    // could only be cleared by hand-written DDL on the staging database. The
    // feature's own supported flow produces exactly that divergence (drop a
    // column in staging, promote, production keeps it — promote-preview's
    // `ignoredRemovals`).
    //
    // DESTRUCTIVE, DELIBERATELY, AND ONLY AGAINST STAGING. reconcileStagingSchema
    // drops staging-only tables and columns and rewrites diverged types. Its
    // own doc comment carries the reasoning; the two things to hold onto here
    // are that PROMOTE's hard refusal is untouched and opposite by design, and
    // that every destroyed object is named on the job below.
    const reconciled = await reconcileStagingSchema({
      prodPool,
      stagingPool,
      stagingAppId,
      // Re-run immediately before the DDL executes. Passed as a callback so
      // the guards keep ONE implementation — the reconcile module has no
      // business knowing about job id pairs or `apps.db_name`, and a second
      // copy of these checks over there is exactly how they drift.
      assertStagingTarget: () => assertStagingTarget({
        prodAppId, stagingAppId, prodPool, stagingPool, stagingDbName, action: 'alter schema',
      }),
      logger,
    });

    // NAME WHAT IT DESTROYED. The standing rule's ninth application: a user who
    // loses a scratch column or table to a reset learns it from the job record,
    // not by noticing later that it is gone.
    if (reconciled.destroyed.length > 0) {
      await appendCloneJobWarnings(controlDb, jobId, [
        `Reset changed staging's schema to match production and, in doing so, `
          + `destroyed ${reconciled.destroyed.length} `
          + `${reconciled.destroyed.length === 1 ? 'object' : 'objects'} that existed only on `
          + `staging or differed from production: ${reconciled.destroyed.join('; ')}. Reset `
          + 'makes staging match production; production was not touched.',
      ]);
    }

    // Direction is PRODUCTION -> STAGING. prodPool is always the first
    // argument, stagingPool always the second — matches replaySeedData's
    // (sourceAppPool, destAppPool, logger) signature exactly, with
    // "source" = production and "dest" = staging for a reset.
    const seedResult = await replaySeedData(prodPool, stagingPool, logger);

    // THE RETURN VALUE IS NOT DECORATION. replaySeedData soft-fails PER TABLE:
    // a column mismatch or a constraint violation makes it push a string onto
    // `warnings`, log, and move to the next table — it never throws. Dropping
    // that return value, which this function used to do, is the single place
    // in this feature that breaks its own standing rule ("do the conservative
    // thing, then NAME it"): a reset that failed to repopulate a table
    // finished with status 'completed' and not one word anywhere the user
    // could see. executeClone has appended these to the job since the seed
    // step existed; reset now does the same.
    if (seedResult.warnings.length > 0) {
      await appendCloneJobWarnings(controlDb, jobId, seedResult.warnings);
    }

    // NO "emptied but not refilled" WARNING ANY MORE, and the absence is
    // deliberate. That warning existed for the table the truncate emptied and
    // nothing refilled — a staging-only table — back when reset left it in
    // place. Reset now DROPS it, and the `destroyed` disclosure above names it
    // precisely ('dropped staging-only table "scratch_notes"'). Reinstating a
    // second line saying the same table "is now empty; the table itself is
    // left in place" would state the opposite of what happened. The
    // arithmetic that produced it — staging's truncated tables minus
    // production's — is exactly the set the reconcile now drops, so there is
    // nothing left for it to report.

    // Re-isolate: a fresh copy of production carries production's connected
    // accounts, enabled integrations and enabled cron triggers back into
    // staging. Must run AFTER the re-seed (not before) — isolating first
    // would only be immediately undone by the rows replaySeedData just
    // copied in. Same two calls, same order, as finalizeStagingClone
    // (staging-completion.ts) uses after a staging_create clone.
    //
    // When a production data copy follows (below) this is NOT the last
    // isolation: the copy re-imports the same three things all over again, and
    // the wait task in neon-task-worker.ts isolates once more after it lands.
    // Both calls are needed - this one closes the window while the copy runs,
    // that one neutralises what the copy brought.
    await isolateStagingApp(runtimeDb, stagingAppId);
    await isolateStagingMeetingsWebhook(controlDb, stagingAppId);

    // PRODUCTION DATA COPY.
    //
    // replaySeedData above carries the _seed-flagged tables only, which is a
    // small fraction of what "reset from production" claims. The rest - every
    // other table's rows, the auth users, the uploaded files and their bytes -
    // is copied by the app-copy engine, enqueued here and executed on its own
    // worker (see staging-data-copy.ts for why this repo enqueues rather than
    // calls).
    //
    // replaySeedData is kept rather than replaced. It is idempotent with the
    // copy (both are INSERT ... ON CONFLICT DO NOTHING on the same row ids),
    // it costs one pass over a small table set, and it means a reset whose
    // copy later fails leaves staging with its seed data rather than with the
    // empty tables the TRUNCATE just made. Supplementing, not swapping.
    //
    // THE JOB DOES NOT COMPLETE HERE when a copy is enqueued. It parks in
    // 'copying_data' and the wait task completes it - including
    // touchEnvironmentTimestamp, which must not move until the reset it dates
    // has actually happened.
    if (region) {
      const enqueued = await enqueueStagingDataCopy({
        controlDb, prodAppId, stagingAppId, region,
        requestedByUserId: job.requested_by_user_id,
      });
      if (enqueued.ok) {
        await setCloneJobStatus(controlDb, jobId, {
          status: 'copying_data', data_copy_job_id: enqueued.copyJobId,
        });
        await enqueueCopyWaitTask({
          appId: stagingAppId, region, jobId, delayMs: COPY_POLL_INTERVAL_MS,
        });
        logger.info(
          { jobId, prodAppId, stagingAppId, copyJobId: enqueued.copyJobId },
          '[staging-reset] production data copy enqueued; job parked in copying_data',
        );
        return;
      }
      if (enqueued.reason === 'unsupported') {
        // OSS-only deployment: no app_copy_jobs table, no overlay worker. Fall
        // through to today's behaviour, but never silently - the job carries
        // the reason the user can read.
        await appendCloneJobWarnings(controlDb, jobId, [enqueued.message]);
        logger.warn(
          { jobId, prodAppId, stagingAppId },
          '[staging-reset] no app-copy engine on this deployment; re-seeded from _seed tables only',
        );
      } else {
        // A conflicting copy that went terminal mid-flight: transient, and the
        // attempt-gated catch below gives the queue another go.
        throw new Error(enqueued.message);
      }
    }

    // Keyed on the PRODUCTION app id: app_environments.prod_app_id is the
    // table's primary key (touchEnvironmentTimestamp / app_environments.ts).
    await touchEnvironmentTimestamp(runtimeDb, prodAppId, 'last_reset_at');

    await setCloneJobStatus(controlDb, jobId, { status: 'completed', completed_at: new Date() });
    logger.info({ jobId, prodAppId, stagingAppId }, '[staging-reset] completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Attempt-gated, matching executePromote and executeUpdate: 'failed' is
    // written only once the neon_tasks queue has exhausted its attempts.
    // Marking failed on attempt 1 of N would make every remaining attempt a
    // silent no-op, because 'failed' is a terminal status the re-entry guard
    // in the worker short-circuits on.
    const isPermanent = attempt >= maxAttempts;
    if (isPermanent) {
      await setCloneJobStatus(controlDb, jobId, {
        status: 'failed', error_message: msg, completed_at: new Date(),
      }).catch(() => {});
      logger.error({ err, jobId, prodAppId, stagingAppId }, '[staging-reset] failed');
    } else {
      await setCloneJobStatus(controlDb, jobId, { error_message: msg }).catch(() => {});
      logger.warn(
        { jobId, prodAppId, stagingAppId, attempt, maxAttempts, error: msg },
        '[staging-reset] transient failure, will retry',
      );
    }
    throw err;
  }
}
