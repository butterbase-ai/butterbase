import type pg from 'pg';
import { getEnvironmentLink, touchEnvironmentTimestamp } from './app-environments.js';
import { replaySeedData, getSeedTableNames } from './clone-replay.js';
import { isolateStagingApp, isolateStagingMeetingsWebhook } from './staging-isolation.js';
import {
  enqueueStagingDataCopy, enqueueCopyWaitTask, COPY_POLL_INTERVAL_MS,
} from './staging-data-copy.js';
import {
  setCloneJobStatus, createCloneJob, appendCloneJobWarnings, type CloneJob,
} from './clone-jobs.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { getActivePromoteJob } from './promote-jobs.js';
import { EXCLUDED_TABLES } from './schema-introspector.js';

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
   * see truncateStagingSeedTables's Guard 3. Every other guard compares
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
 * Empties the staging app's seed-flagged tables before replaySeedData
 * re-populates them from production.
 *
 * WITHOUT THIS, A RESET IS NEARLY A NO-OP: replaySeedData issues
 * `INSERT ... ON CONFLICT DO NOTHING`, so any row already present in staging
 * — which is the entire reason anyone runs a reset, staging has drifted —
 * survives with its stale staging value. `manage_staging`'s tool text already
 * promises callers reset "discards the staging app's data"; this is what
 * makes that true.
 *
 * THREE INDEPENDENT GUARDS before the TRUNCATE runs, because a TRUNCATE aimed
 * at the wrong pool destroys a customer's PRODUCTION data, unrecoverably —
 * this is exactly as dangerous as the replaySeedData argument-order hazard
 * documented on executeStagingReset below, just on the truncate side instead
 * of the insert side:
 *
 *   1. stagingAppId === prodAppId is refused — on a reset job these must
 *      always differ (source_app_id is production, dest_app_id is staging).
 *      If they were ever equal, something upstream (startStagingReset,
 *      resolveCloneDispatch's routing, or the CloneJob row itself) is
 *      broken, and the only safe response is to fail loudly before running
 *      any SQL.
 *   2. stagingPool === prodPool (reference equality) is refused — this
 *      catches a pool-resolution bug (e.g. getAppPoolForApp's cache keyed
 *      wrong) that the id check above cannot see, since it is entirely
 *      possible for two different app ids to end up resolving to the same
 *      pool object if the caching key were ever wrong.
 *   3. `SELECT current_database()` on stagingPool must equal the caller-
 *      supplied `stagingDbName`, checked immediately before the TRUNCATE.
 *      Guards 1 and 2 both compare values chosen UPSTREAM of the
 *      getAppPoolForApp call in neon-task-worker.ts's executeResetTask — if
 *      that call's two `pg.Pool` assignments were ever swapped (i.e.
 *      `prodPool` gets the app id/db_name that actually belong to staging,
 *      and vice versa), both ids would still differ and both pool objects
 *      would still be distinct, so guards 1 and 2 would both pass while the
 *      TRUNCATE runs against production. Guard 3 is the only one that asks
 *      about the live connection instead of a value threaded through
 *      arguments, so it is the only one that still catches that swap.
 *
 * Table set: derived via getSeedTableNames — the exact same `_seed_tables`
 * registry lookup replaySeedData itself uses — read from the STAGING
 * (destination) pool, not hardcoded. Read from staging rather than
 * production because these are the tables that must physically exist on the
 * pool being truncated; reset is defined as "discard staging's own seed
 * data", so a seed table staging has (even one production has since
 * removed) is still cleared. Filtered again against schema-introspector.ts's
 * `EXCLUDED_TABLES` (Butterbase's own per-app bookkeeping: `_rag_*`,
 * `_idempotency_keys`, the migration-tracking tables, `_seed_tables` itself)
 * before use — belt-and-suspenders: today none of those tables can reach
 * `_seed_tables` (schema-differ.ts's bare `CREATE TABLE`, without `IF NOT
 * EXISTS`, errors before a user schema could ever register one under a
 * reserved name), but that is an emergent property of two OTHER modules,
 * not an invariant this file enforces itself. This filter makes "never
 * truncate our own bookkeeping tables" true here even if that upstream
 * behavior ever changes.
 *
 * Runs `TRUNCATE ... CASCADE` rather than a table-by-table DELETE, so
 * Postgres resolves foreign-key ordering itself. CASCADE is a deliberate
 * choice over a strict, closure-only TRUNCATE (which would refuse to run at
 * all if staging has a non-seed table with a foreign key into a seed table —
 * e.g. a scratch table someone created only in staging while experimenting).
 * Reset's contract is "discard the staging app's data"; a staging-only table
 * IS staging data, so sweeping it is within that contract, and refusing to
 * run at all would be strictly worse for that legitimate case. See the Task
 * 16 fix-round-1 write-up for the schema audit establishing that
 * Butterbase's own data-plane infrastructure tables (`_rag_*`,
 * `_idempotency_keys`, `_data_plane_migrations`, `_ai_migrations`,
 * `_seed_tables`) never carry a foreign key into an app-defined seed table,
 * so CASCADE cannot reach them in practice.
 *
 * STANDING RULE (fifth time this feature has needed it — see Task 11's
 * ignoredRemovals, Task 13's surfaced RLS policies and disabled-trigger
 * disclosure, Task 14's zero-rewrite and Pages-still-building warnings): do
 * the conservative thing, then name it. CASCADE reaching a table outside the
 * seed set is exactly that shape — sweeping it is the right call, but the
 * user must be able to reconstruct what happened from the job record alone,
 * not from server logs they cannot see. Before running the TRUNCATE, this
 * makes a best-effort (non-blocking) attempt to discover which OTHER tables
 * a cascade would reach — via the same foreign-key graph Postgres itself
 * would follow — and appends a job warning naming them if any are found.
 * The discovery query itself must NEVER gate or fail the truncate: a missing
 * warning is not worth failing a reset that otherwise succeeded, so a
 * discovery failure is caught, logged, and the truncate proceeds anyway. Do
 * not "fix" that into a hard failure — a failed introspection query says
 * nothing about whether the TRUNCATE itself would have been safe.
 */
async function truncateStagingSeedTables(args: {
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

  // Guard 1: id-level. See doc comment above.
  if (stagingAppId === prodAppId) {
    throw new Error(
      `[staging-reset] refusing to truncate: dest_app_id (staging, ${stagingAppId}) equals `
        + `source_app_id (production, ${prodAppId})`,
    );
  }
  // Guard 2: pool-identity level. See doc comment above.
  if (stagingPool === prodPool) {
    throw new Error(
      '[staging-reset] refusing to truncate: the staging pool is reference-identical to the '
        + 'production pool',
    );
  }

  const rawSeedTables = await getSeedTableNames(stagingPool, logger);
  // See the function doc comment on why this filter exists even though
  // nothing currently reaches it: structural, not emergent.
  const seedTables = rawSeedTables.filter((t) => !EXCLUDED_TABLES.includes(t));
  if (seedTables.length !== rawSeedTables.length) {
    logger.warn(
      {
        stagingAppId,
        excluded: rawSeedTables.filter((t) => EXCLUDED_TABLES.includes(t)),
      },
      '[staging-reset] _seed_tables named a Butterbase-internal bookkeeping table; excluded it '
        + 'from truncation (this should never happen — see truncateStagingSeedTables doc comment)',
    );
  }
  if (seedTables.length === 0) {
    logger.info(
      { stagingAppId },
      '[staging-reset] no seed-flagged tables on staging; nothing to truncate',
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
      `WITH RECURSIVE seed(name) AS (
         SELECT unnest($1::text[])
       ), reached AS (
         SELECT name FROM seed
         UNION
         SELECT c.conrelid::regclass::text AS name
         FROM pg_constraint c
         JOIN reached r ON c.confrelid::regclass::text = r.name
         WHERE c.contype = 'f'
       )
       SELECT DISTINCT name AS table_name FROM reached`,
      [seedTables],
    );
    const reached = closure.rows.map((r) => r.table_name.split('.').pop() ?? r.table_name);
    const extra = reached.filter((t) => !seedTables.includes(t));
    if (extra.length > 0) {
      logger.warn(
        { stagingAppId, seedTables, cascadeReaches: extra },
        '[staging-reset] TRUNCATE ... CASCADE will also reach these non-seed tables via foreign key',
      );
      // Job-level, not just a log line: the user cannot see server logs, and
      // has to be able to learn from the job record alone that their reset
      // also cleared these tables.
      await appendCloneJobWarnings(controlDb, jobId, [
        `Reset also cleared ${extra.length} non-seed ${extra.length === 1 ? 'table' : 'tables'} `
          + `on staging via foreign-key cascade: ${extra.join(', ')}. These tables exist on `
          + 'staging but are not flagged _seed:true, so TRUNCATE ... CASCADE swept them along '
          + 'with the seed tables it truncated deliberately.',
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

  // Guard 3: connection-level. See doc comment above — this is the only
  // guard that catches a swap of the getAppPoolForApp assignments upstream
  // (neon-task-worker.ts's executeResetTask), because it asks the live
  // connection which physical database it is pointed at instead of
  // re-checking a value that was already threaded through the same
  // (possibly swapped) call. Checked immediately before the TRUNCATE, as
  // close to the hazard as possible.
  const dbCheck = await stagingPool.query<{ current_database: string }>(
    'SELECT current_database()',
  );
  const connectedDb = dbCheck.rows[0]?.current_database;
  if (connectedDb !== stagingDbName) {
    throw new Error(
      `[staging-reset] refusing to truncate: staging pool for app ${stagingAppId} is connected `
        + `to database "${connectedDb}", expected "${stagingDbName}"`,
    );
  }

  const tableList = seedTables.map((t) => `"${t}"`).join(', ');
  await stagingPool.query(`TRUNCATE TABLE ${tableList} CASCADE`);
  logger.info(
    { stagingAppId, tables: seedTables },
    '[staging-reset] truncated staging seed tables before re-seed',
  );

  return { tables: seedTables };
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
  // truncateStagingSeedTables's doc comment for why this is checked again,
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

    // Truncate BEFORE re-seeding: replaySeedData is INSERT ... ON CONFLICT DO
    // NOTHING, so without this step a reset would leave every row staging
    // already had untouched — see truncateStagingSeedTables's doc comment.
    await truncateStagingSeedTables({
      prodAppId, stagingAppId, prodPool, stagingPool, stagingDbName, controlDb, jobId, logger,
    });

    // Direction is PRODUCTION -> STAGING. prodPool is always the first
    // argument, stagingPool always the second — matches replaySeedData's
    // (sourceAppPool, destAppPool, logger) signature exactly, with
    // "source" = production and "dest" = staging for a reset.
    await replaySeedData(prodPool, stagingPool, logger);

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
