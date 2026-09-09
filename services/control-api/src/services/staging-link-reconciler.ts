import type pg from 'pg';
import { config } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { linkEnvironments } from './app-environments.js';
import { TERMINAL_CLONE_STATUSES } from './clone-jobs.js';

/**
 * Repairs staging environments that were fully provisioned but never linked.
 *
 * `finalizeStagingClone` (staging-completion.ts) writes the `app_environments`
 * row LAST, after the destination app is provisioned, isolated and — when the
 * app-copy engine is in play — populated with production's data. If that one
 * write fails permanently, the outcome is the worst shape this feature has:
 * a staging app that exists, is running, holds a copy of the customer's
 * production data, and costs them money, while being invisible to the
 * dashboard, to `getEnvironmentLink` (so reset and promote both answer
 * NO_STAGING), and to the idle reaper — whose every statement is scoped
 * through `app_environments`, so an unlinked staging app is never paused and
 * never reaped. A comment in the clone worker said "backfill will repair".
 * There was no backfill. This is it.
 *
 * ---------------------------------------------------------------------------
 * IDENTIFICATION: what marks an app as INTENDED to be staging when the link
 * row is exactly the thing that is missing?
 * ---------------------------------------------------------------------------
 *
 * The signal is `template_clone_jobs.dest_app_id` on a row with
 * `mode = 'staging_create'`, and it is not a heuristic — it is the create
 * path's own record of its own intent, written in two halves that no other
 * code path writes:
 *
 *   - `mode = 'staging_create'` is written by exactly ONE statement in the
 *     codebase, `start-staging.ts`'s post-insert UPDATE. Nothing else sets it.
 *   - `dest_app_id` on such a job is written by exactly ONE statement, the
 *     clone worker's `setCloneJobStatus(controlDb, jobId, { dest_app_id })`,
 *     immediately after `insertAppRow` creates the app — and the id it writes
 *     came from `generateAppId()` moments earlier. It is, by construction, an
 *     app that was brought into existence to be this job's staging
 *     environment.
 *
 * So a pre-existing production app can NEVER appear as the `dest_app_id` of a
 * `staging_create` job. That is the property that makes "wrongly treat a
 * normal app as an orphaned staging app" impossible rather than unlikely, and
 * it is a property of where the value comes from, not of a string pattern or a
 * name convention. See FALSE POSITIVES below for the cases that are merely
 * unlikely, each of which is handled by refusing rather than by guessing.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES: relink, not merely flag.
 * ---------------------------------------------------------------------------
 *
 * Relinking writes exactly the row the create path already decided to write
 * and failed to land — it invents nothing. Flagging alone would leave the
 * customer paying for an invisible app until a human noticed a report they
 * have no reason to read, which is the status quo this exists to end.
 *
 * The asymmetry that makes relinking acceptable is which mistake is
 * recoverable. Relinking a genuine orphan restores the intended state.
 * Relinking something that should not have been linked makes an app appear in
 * the dashboard as staging and become eligible for idle PAUSING — reversible
 * with one DELETE and one unpause, and never destructive. The unrecoverable
 * mistake would be naming a live PRODUCTION app as somebody's
 * `staging_app_id`, because the idle reaper would then pause a customer's live
 * site; the identification above makes that unreachable.
 *
 * Anything the conjunction below does not fully satisfy is REPORTED, never
 * written. `flagged` is where a human's judgement is genuinely required.
 *
 * ---------------------------------------------------------------------------
 * FALSE POSITIVES, and why each is refused rather than guessed at
 * ---------------------------------------------------------------------------
 *
 *  1. A LIVE PRODUCTION APP. Impossible, see IDENTIFICATION: `dest_app_id` on
 *     a `staging_create` job is only ever a freshly generated id. Additionally
 *     guarded: a candidate that also appears as the `source_app_id` of ANY
 *     `staging_create` job (the defining trait of a production app — somebody
 *     asked for a staging environment OF it) is refused as ambiguous.
 *
 *  2. A DELIBERATELY UNLINKED STAGING APP. `DELETE /v1/apps/:id/staging`
 *     removes the link on purpose, tells the caller in its response that the
 *     app is retained and is no longer covered by idle-pausing, and records a
 *     `staging.unlink` audit event whose `resource_id` is the retained
 *     staging app id. Relinking that would silently undo a deliberate user
 *     action, so any candidate with such an audit event is refused. This is
 *     the false positive that actually matters: it is structurally identical
 *     to a true orphan from the job row alone, and the audit event is the only
 *     durable record that distinguishes them.
 *
 *  3. A HALF-BUILT STAGING APP. Only jobs with `status = 'completed'` are
 *     considered, and the staging app must additionally read
 *     `provisioning_status = 'ready'` in its runtime plane. A job still in
 *     `copying_data` has not reached its link write yet and is not an orphan;
 *     a failed job's destination may be a shell.
 *
 *  4. A RACE WITH THE WORKER ITSELF. Two guards: a grace window (default 24h
 *     after `completed_at`, mirroring neon-orphan-reconciler.ts) and a refusal
 *     when either app has a non-terminal clone job of any mode. A retry that
 *     is about to write the link must not be raced.
 *
 *  5. THE WRONG STAGING APP. If a production app has more than one completed
 *     `staging_create` job with distinct `dest_app_id`s and none is linked,
 *     which one is "the" staging environment is a guess. Refused, flagged.
 *
 *  6. A PAIR THAT IS ALREADY LINKED, OR LINKED ELSEWHERE. Skipped when the
 *     production app already has any `app_environments` row, and when the
 *     candidate staging app is already somebody else's `staging_app_id`.
 *
 *  7. CROSS-REGION. `app_environments` lives in a regional runtime plane and
 *     both its foreign keys must resolve locally. Both rows must be present in
 *     the same regional pool or the candidate is refused — the row would be
 *     unwritable anyway, and failing on the FK is a worse way to find out.
 *
 *  8. CORROBORATION ACROSS PLANES. The staging app's runtime `apps` row must
 *     carry `template_source_app_id = <the job's source_app_id>` — the same
 *     clone worker wrote both, so a candidate where they disagree means one of
 *     the two records is wrong and neither can be trusted. Refused, flagged.
 *
 * Dry-run by default, like neon-orphan-reconciler.ts: a mutating sweep says
 * what it WOULD do unless an operator explicitly opts in.
 */

export interface ReconcileLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface StagingLinkReconcileOptions {
  /** Never touch a job that completed less than this long ago. Default 24. */
  graceHours: number;
  /** Bounds blast radius per run. Oldest candidates go first. Default 10. */
  maxRelinksPerRun: number;
  /** When true (the default) nothing is written; candidates land in `wouldRelink`. */
  dryRun: boolean;
  /** ISO string; overridable for tests. */
  now?: string;
  /**
   * Resolve a region's runtime pool. Defaults to the configured regional
   * pools; injectable so the real-DB test can point every region at the one
   * local runtime plane it has.
   */
  runtimePoolForRegion?: (region: string) => pg.Pool;
}

export interface StagingLinkCandidate {
  job_id: string;
  prod_app_id: string;
  staging_app_id: string;
  region: string;
}

export interface FlaggedCandidate extends StagingLinkCandidate {
  /** Why a human has to decide. Ids only — never a row, a name or a value. */
  reason: string;
}

export interface StagingLinkReconcileResult {
  candidateCount: number;
  relinked: StagingLinkCandidate[];
  wouldRelink: StagingLinkCandidate[];
  skippedYoung: number;
  skippedInflight: number;
  skippedDeliberateUnlink: number;
  skippedAlreadyLinked: number;
  skippedNotReady: number;
  flagged: FlaggedCandidate[];
  errors: { job_id: string; error: string }[];
}

export function optionsFromEnv(): StagingLinkReconcileOptions {
  const graceHours = Number.parseInt(process.env.BUTTERBASE_STAGING_RELINK_GRACE_HOURS ?? '', 10);
  const maxRelinks = Number.parseInt(process.env.BUTTERBASE_STAGING_RELINK_MAX ?? '', 10);
  return {
    graceHours: Number.isInteger(graceHours) && graceHours >= 0 ? graceHours : 24,
    maxRelinksPerRun: Number.isInteger(maxRelinks) && maxRelinks > 0 ? maxRelinks : 10,
    // Explicit opt-in, exactly like NEON_ORPHAN_DRY_RUN: anything other than
    // the literal string 'false' leaves this a report-only sweep.
    dryRun: process.env.BUTTERBASE_STAGING_RELINK_DRY_RUN !== 'false',
  };
}

interface CandidateRow {
  job_id: string;
  prod_app_id: string;
  staging_app_id: string;
  region: string;
  requested_by_user_id: string;
  completed_at: Date | null;
}

export async function reconcileStagingLinks(
  controlDb: pg.Pool,
  logger: ReconcileLogger,
  opts: StagingLinkReconcileOptions = optionsFromEnv(),
): Promise<StagingLinkReconcileResult> {
  const now = opts.now ? new Date(opts.now) : new Date();
  const cutoff = new Date(now.getTime() - opts.graceHours * 60 * 60 * 1000);
  const poolFor = opts.runtimePoolForRegion
    ?? ((region: string) => getRuntimeDbPool(config.runtimeDb, region));

  const result: StagingLinkReconcileResult = {
    candidateCount: 0,
    relinked: [],
    wouldRelink: [],
    skippedYoung: 0,
    skippedInflight: 0,
    skippedDeliberateUnlink: 0,
    skippedAlreadyLinked: 0,
    skippedNotReady: 0,
    flagged: [],
    errors: [],
  };

  // Candidates come from the create path's own record of its own intent. Every
  // predicate here is load-bearing; see the FALSE POSITIVES analysis above.
  //
  // `status = 'completed'` rather than `NOT IN (terminal)`: a failed job's
  // destination may be a half-built shell, and an in-flight job simply has not
  // reached its link write yet.
  const { rows: raw } = await controlDb.query<CandidateRow>(
    `SELECT id AS job_id,
            source_app_id AS prod_app_id,
            dest_app_id   AS staging_app_id,
            dest_region   AS region,
            requested_by_user_id,
            completed_at
       FROM template_clone_jobs
      WHERE mode = 'staging_create'
        AND status = 'completed'
        AND dest_app_id IS NOT NULL
      ORDER BY completed_at ASC NULLS LAST`,
  );

  // Grace window. A job whose completed_at is NULL is treated as young rather
  // than as old: an unknown age is not evidence of an orphan.
  const aged: CandidateRow[] = [];
  for (const row of raw) {
    if (!row.completed_at || row.completed_at > cutoff) {
      result.skippedYoung += 1;
      continue;
    }
    aged.push(row);
  }
  result.candidateCount = aged.length;

  // False positive 5: more than one distinct completed destination for the
  // same production app means "which one is the staging environment" is a
  // guess. Computed over EVERY completed staging_create job for that prod app,
  // including ones inside the grace window, so a fresh retry cannot make an
  // older ambiguous pair look unambiguous.
  const destsByProd = new Map<string, Set<string>>();
  for (const row of raw) {
    const set = destsByProd.get(row.prod_app_id) ?? new Set<string>();
    set.add(row.staging_app_id);
    destsByProd.set(row.prod_app_id, set);
  }

  for (const row of aged) {
    if (result.relinked.length + result.wouldRelink.length >= opts.maxRelinksPerRun) break;

    const candidate: StagingLinkCandidate = {
      job_id: row.job_id,
      prod_app_id: row.prod_app_id,
      staging_app_id: row.staging_app_id,
      region: row.region,
    };

    try {
      if ((destsByProd.get(row.prod_app_id)?.size ?? 0) > 1) {
        result.flagged.push({
          ...candidate,
          reason: 'more than one completed staging_create destination for this production app; '
            + 'which one is the staging environment cannot be determined without a human',
        });
        continue;
      }

      // False positive 1, second guard: a candidate that is itself the SOURCE
      // of a staging_create job is something somebody asked for a staging
      // environment OF — i.e. it behaves like a production app. Refuse.
      const asSource = await controlDb.query(
        `SELECT 1 FROM template_clone_jobs
          WHERE mode = 'staging_create' AND source_app_id = $1 LIMIT 1`,
        [row.staging_app_id],
      );
      if (asSource.rows.length > 0) {
        result.flagged.push({
          ...candidate,
          reason: 'candidate staging app is itself the source of a staging_create job; refusing '
            + 'to treat an app that has had a staging environment requested of it as staging',
        });
        continue;
      }

      // False positive 2: a deliberate unlink. Refused, not merely skipped for
      // a later run — the user made this decision and was told what it meant.
      const unlinked = await controlDb.query(
        `SELECT 1 FROM audit_events
          WHERE event_type = 'staging.unlink' AND resource_id = $1 LIMIT 1`,
        [row.staging_app_id],
      );
      if (unlinked.rows.length > 0) {
        result.skippedDeliberateUnlink += 1;
        continue;
      }

      // False positive 4: never race a worker that still owns either app.
      const inflight = await controlDb.query(
        `SELECT 1 FROM template_clone_jobs
          WHERE NOT (status = ANY($2::text[]))
            AND (source_app_id = $1 OR dest_app_id = $1 OR source_app_id = $3 OR dest_app_id = $3)
          LIMIT 1`,
        [row.prod_app_id, TERMINAL_CLONE_STATUSES, row.staging_app_id],
      );
      if (inflight.rows.length > 0) {
        result.skippedInflight += 1;
        continue;
      }

      const runtimeDb = poolFor(row.region);

      // False positives 3, 7 and 8. Both rows must be present in the SAME
      // regional pool (app_environments' foreign keys are local), the staging
      // app must be genuinely ready, and the runtime plane's own record of the
      // clone must corroborate the control plane's.
      const prodRow = await runtimeDb.query(
        `SELECT 1 FROM apps WHERE id = $1`, [row.prod_app_id],
      );
      if (prodRow.rows.length === 0) {
        result.flagged.push({
          ...candidate,
          reason: 'production app row is not present in the region the job names; the link row '
            + 'foreign keys could not resolve locally',
        });
        continue;
      }

      const stagingRow = await runtimeDb.query<{
        provisioning_status: string | null;
        template_source_app_id: string | null;
      }>(
        `SELECT provisioning_status, template_source_app_id FROM apps WHERE id = $1`,
        [row.staging_app_id],
      );
      if (stagingRow.rows.length === 0) {
        // The app is gone. Nothing to link, and nothing to worry about — this
        // is the healthy end state for a staging app that was deleted.
        result.skippedNotReady += 1;
        continue;
      }
      if (stagingRow.rows[0].provisioning_status !== 'ready') {
        result.skippedNotReady += 1;
        continue;
      }
      if (stagingRow.rows[0].template_source_app_id !== row.prod_app_id) {
        result.flagged.push({
          ...candidate,
          reason: "the staging app's runtime lineage does not name this production app; the "
            + 'control-plane job and the runtime app row disagree about what this app is',
        });
        continue;
      }

      // False positive 6.
      const existing = await runtimeDb.query(
        `SELECT 1 FROM app_environments
          WHERE prod_app_id = $1 OR staging_app_id = $2 LIMIT 1`,
        [row.prod_app_id, row.staging_app_id],
      );
      if (existing.rows.length > 0) {
        result.skippedAlreadyLinked += 1;
        continue;
      }

      if (opts.dryRun) {
        result.wouldRelink.push(candidate);
        continue;
      }

      // linkEnvironments is idempotent for the identical pair and throws for a
      // mismatched one — the same write finalizeStagingClone would have made,
      // with the same safety.
      await linkEnvironments(runtimeDb, {
        prodAppId: row.prod_app_id,
        stagingAppId: row.staging_app_id,
        createdBy: row.requested_by_user_id,
      });
      result.relinked.push(candidate);
      logger.info(candidate, '[staging-link-reconciler] relinked orphaned staging environment');
    } catch (err) {
      result.errors.push({
        job_id: row.job_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info(
    {
      candidateCount: result.candidateCount,
      relinked: result.relinked.length,
      wouldRelink: result.wouldRelink.length,
      flagged: result.flagged.length,
      skippedYoung: result.skippedYoung,
      skippedInflight: result.skippedInflight,
      skippedDeliberateUnlink: result.skippedDeliberateUnlink,
      skippedAlreadyLinked: result.skippedAlreadyLinked,
      skippedNotReady: result.skippedNotReady,
      errors: result.errors.length,
      dryRun: opts.dryRun,
    },
    '[staging-link-reconciler] sweep complete',
  );

  return result;
}
