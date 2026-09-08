/**
 * Applies a staging app's state onto its LIVE production app.
 *
 * This is the only code path in the staging feature that writes to a customer's
 * production database. It is modelled directly on executeUpdate
 * (neon-task-worker.ts:1460+), which has been applying one app's state onto
 * another live app with real rows in it since the template-update feature
 * shipped: same additive-only schema filter, same add-only RLS, same
 * insert-only config, same status transitions, same resumability, same
 * fail-and-rethrow contract.
 *
 * The one structural difference is that the step list is not hard-coded here.
 * It comes from replay-registry, so "which primitives travel in a promote" is
 * declared in exactly one place and the MCP tool text, the preview and this
 * executor cannot drift apart.
 *
 * Safety properties, each of which has a test:
 *
 *   - Seed data NEVER travels. `seed_data` is promotable: false in the
 *     registry, so this loop can never reach replaySeedData. Promote must not
 *     overwrite production rows; data flows prod -> staging only, via reset.
 *   - Schema is additive-only. startPromote (Task 12) already refuses a
 *     destructive promote up front, but the staging schema can change between
 *     the preview and this execution, so filterAdditive is applied AGAIN here
 *     as a second line of defence. Do not remove it.
 *   - RLS is add-only by construction: replayRls only issues CREATE POLICY and
 *     ENABLE/FORCE ROW LEVEL SECURITY, never DROP POLICY or DISABLE.
 *   - Production secrets survive. Config replay runs insertOnly (otherwise it
 *     NULLs prod's OAuth client secret, re-mints prod's Composio credentials
 *     and replaces prod's allowed_origins). Function env vars of pre-existing
 *     functions are left alone by replayFunctions. DO replay is called with NO
 *     opts, so app_do_env_vars on production is never written.
 *   - Every step is re-enterable: replaySchema diffs against the destination's
 *     CURRENT schema, replayRls tolerates "already exists", replayFunctions and
 *     the DO replay upsert, config is insert-only, and touchEnvironmentTimestamp
 *     is a plain UPDATE. A retry after a mid-flight crash finishes the job.
 *   - There is no silent no-op. Every promotable step has an explicit arm, and
 *     the default arm THROWS. If a future registry row lands without an arm
 *     here, the promote fails loudly rather than quietly skipping a primitive
 *     the user was told would be promoted.
 *
 * DIVERGENCE FROM executeUpdate (Task 14): executeUpdate publishes the repo
 * and deliberately leaves the deployed artifact alone (neon-task-worker.ts,
 * around the "the fork's deployed frontend artifact is deliberately NOT
 * touched" comment) — deployment is left to the fork owner. Promote is
 * different by explicit product decision: "promote takes staging live" means
 * the deploy IS part of the job, so the 'frontend' case below throws on
 * failure instead of the soft-fail replayFrontend normally does for clone and
 * update. See that case for what a deploy failure leaves behind.
 */
import type pg from 'pg';
import {
  replaySchema,
  replayRls,
  replayFunctions,
  replayNonSecretConfig,
  replayFrontend,
} from './clone-replay.js';
import { replayDurableObjectsForClone } from './durable-objects.service.js';
import { filterAdditive } from './schema-additive-filter.js';
import { setCloneJobStatus, appendCloneJobWarnings, type CloneJob } from './clone-jobs.js';
import { touchEnvironmentTimestamp } from './app-environments.js';
import { promotableSteps } from './replay-registry.js';
import {
  getManifestJson,
  copyBlobSameRegion,
  copyManifestSameRegion,
  setLatest,
} from './repo-storage.js';

export interface PromoteLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface PromoteDeps {
  /** Control-tier pool: template_clone_jobs lives here. */
  controlDb: pg.Pool;
  /**
   * Regional runtime pool. `apps`, `app_functions`, `app_durable_objects`,
   * `app_do_env_vars`, `app_oauth_configs`, `app_environments` and friends are
   * all runtime-tier tables, and staging is pinned to production's region
   * (start-staging.ts), so ONE pool serves as both source and destination for
   * every runtime-tier replay below.
   */
  runtimeDb: pg.Pool;
  /** Per-app database of the STAGING app (source of the schema/RLS diff). */
  stagingPool: pg.Pool;
  /** Per-app database of the PRODUCTION app (destination). */
  prodPool: pg.Pool;
  /** apps.owner_id of the production app — replayFunctions mints under it. */
  prodOwnerId: string;
  /**
   * The neon_tasks attempt counters for this run (`task.attempts` /
   * `task.max_attempts`). They decide whether a failure is permanent — see the
   * catch block, which mirrors executeUpdate's retry contract.
   */
  attempt: number;
  maxAttempts: number;
  logger: PromoteLogger;
}

export async function executePromote(deps: PromoteDeps, job: CloneJob): Promise<void> {
  const {
    controlDb, runtimeDb, stagingPool, prodPool, prodOwnerId, attempt, maxAttempts, logger,
  } = deps;
  const jobId = job.id;
  const stagingAppId = job.source_app_id;
  // startPromote always writes dest_app_id (it is what
  // idx_template_clone_jobs_one_promote keys on), but the column is nullable,
  // so refuse before touching anything rather than promoting into `undefined`.
  const prodAppId = job.dest_app_id;
  if (!prodAppId) throw new Error(`Promote job ${jobId} has no dest_app_id (production app)`);

  try {
    for (const step of promotableSteps()) {
      await setCloneJobStatus(controlDb, jobId, { status: step.status });

      switch (step.name) {
        case 'schema': {
          // Additive only. See the header: this is deliberately a SECOND check,
          // not a duplicate of Task 12's admission gate.
          await replaySchema(stagingPool, prodPool, prodAppId, logger, { filter: filterAdditive });
          break;
        }

        case 'rls': {
          // Add-only by construction. Necessary, not optional: a table the
          // staging schema added was just created on production with grants to
          // butterbase_anon, so skipping this would publish it wide open.
          const rls = await replayRls(stagingPool, prodPool, logger);
          const preExisting = rls.warnings.filter((w) => /already exists/i.test(w));
          const warnings = rls.warnings.filter((w) => !/already exists/i.test(w));
          if (warnings.length > 0) await appendCloneJobWarnings(controlDb, jobId, warnings);

          // "already exists" is REPORTED here, not swallowed — the opposite of
          // what executeUpdate does with the same string, and deliberately so.
          //
          // replayRls only ever issues CREATE POLICY, so a policy name the
          // destination already has fails with "already exists" and the
          // destination keeps its old definition. On a template update that is
          // correct and uninteresting: a fork's own policies belong to the fork
          // owner and must not be overwritten. On a PROMOTE the expectation is
          // inverted — staging IS the user's edit. Someone who tightened an
          // existing policy in staging and promoted would otherwise get a
          // 'completed' job and an unchanged production policy, with the one
          // piece of evidence filtered out of their warnings.
          //
          // Informational, not an error, and NOT accompanied by a DROP POLICY /
          // replace: rewriting a live production app's access rules from a
          // replay is genuinely dangerous and is out of scope here. Telling the
          // user precisely which edits did not travel lets them apply those by
          // hand; silence lets them believe a tightened policy is live when it
          // is not.
          if (preExisting.length > 0) {
            // replayRls formats these as `RLS policy <table>.<name> failed: ...`
            // — recover the identifier so the warning names each policy rather
            // than restating the raw Postgres error.
            const names = preExisting.map((w) => {
              const m = /^RLS policy (\S+) failed:/.exec(w);
              return m ? m[1] : w;
            });
            await appendCloneJobWarnings(controlDb, jobId, [
              `${names.length} RLS ${names.length === 1 ? 'policy' : 'policies'} already exist on `
                + `production and were left unchanged: ${names.join(', ')}. Promote only ADDS `
                + 'policies — it never rewrites or drops one on a live app — so if you edited '
                + 'any of these in staging, that edit did NOT reach production. Apply it there '
                + 'directly.',
            ]);
          }
          logger.info(
            {
              jobId, prodAppId, replayed: rls.replayed,
              warnings: warnings.length, preExisting: preExisting.length,
            },
            '[promote] RLS policies replayed',
          );
          break;
        }

        case 'durable_objects': {
          // Safe on a live production app, which is why this is a real arm and
          // not a registry demotion. replayDurableObjectsForClone upserts each
          // source class by (app_id, name) and redeploys the destination's own
          // Worker namespace; it never deletes a DO production has and staging
          // lacks, and it never reads or copies DO env var VALUES — those are
          // secrets held in the source's encryption envelope.
          //
          // Called with NO opts on purpose. `sharedMintedKey` and `appOverrides`
          // are the only paths by which it writes app_do_env_vars, and both are
          // clone-provisioning concerns: production already holds its own DO
          // secrets, and minting a fresh bb_sk_ over them would break every DO
          // and function that shares that intra-app credential.
          //
          // Consequence, surfaced as a warning rather than hidden: a DO env key
          // that staging declares and production has never had stays empty, and
          // the owner sets it with manage_durable_objects action=set_env.
          const result = await replayDurableObjectsForClone(
            runtimeDb, runtimeDb, controlDb, stagingAppId, prodAppId, job.requested_by_user_id,
          );
          if (result.cloned.length > 0) {
            logger.info(
              { jobId, prodAppId, cloned: result.cloned },
              '[promote] durable objects replayed',
            );
            await appendCloneJobWarnings(controlDb, jobId, [
              `Durable Objects promoted: ${result.cloned.join(', ')}. DO env var values were `
                + 'not copied from staging — production keeps its own. Any key production has '
                + 'never had is unset; set it with manage_durable_objects action=set_env.',
            ]);
          }
          break;
        }

        case 'functions': {
          // Runtime-tier on both sides. overwriteExisting is the whole point of
          // a promote: staging's function bodies replace production's. Env vars
          // of pre-existing functions are left untouched by replayFunctions
          // (the wasInserted guard in clone-replay.ts) — production's secrets
          // are not staging's to replace.
          //
          // preserveDestinationTriggerEnabled is a correctness requirement, not
          // a preference. isolateStagingApp (staging-isolation.ts) deliberately
          // sets every cron trigger on a staging app to enabled = false so a
          // staging environment does not fire scheduled work at real
          // integrations. The trigger upsert's DO UPDATE SET normally copies
          // `enabled` from the source row, so without this flag a promote
          // switches OFF every scheduled function on the customer's live
          // production app — nightly billing, cleanup, digests — while telling
          // them their functions were promoted. The schedule itself
          // (trigger_config) still travels; only the on/off half is preserved
          // from production.
          const fn = await replayFunctions(
            runtimeDb, runtimeDb, stagingAppId, prodAppId, job.requested_by_user_id, logger,
            {
              overwriteExisting: true,
              preserveDestinationTriggerEnabled: true,
              controlPool: controlDb,
              destAppOwnerId: prodOwnerId,
            },
          );
          if (fn.warnings.length > 0) await appendCloneJobWarnings(controlDb, jobId, fn.warnings);

          // The other half of the isolation-leak above, disclosed rather than
          // fixed. preserveDestinationTriggerEnabled protects triggers
          // production ALREADY has; a trigger added in staging has no
          // production counterpart, so it is INSERTed carrying the
          // `enabled = false` that isolateStagingApp set on staging. It is
          // created on production and never fires.
          //
          // We keep it disabled deliberately: force-enabling would start a
          // recurring job firing at real production data and live integrations
          // that the user never enabled in production — worse than the
          // omission, because it converts a silent gap into unrequested
          // activity. But doing the safe thing silently is the exact failure
          // mode this pipeline keeps closing, so name it. Same pattern as the
          // pre-existing-RLS notice above and Task 11's ignoredRemovals: do the
          // conservative thing, then tell the user you did.
          if (fn.disabledTriggersInserted.length > 0) {
            const list = fn.disabledTriggersInserted.join(', ');
            await appendCloneJobWarnings(controlDb, jobId, [
              `${fn.disabledTriggersInserted.length} new scheduled `
                + `${fn.disabledTriggersInserted.length === 1 ? 'trigger was' : 'triggers were'} `
                + `created on production but ${fn.disabledTriggersInserted.length === 1 ? 'is' : 'are'} `
                + `NOT scheduled to run: ${list}. Staging environments have their cron triggers `
                + 'switched off so they do not fire against real integrations, and promote does '
                + 'not turn them on for you — starting a recurring job against production data is '
                + 'your call, not ours. Enable each one on the production app when you are ready.',
            ]);
            logger.info(
              { jobId, prodAppId, disabledTriggersInserted: fn.disabledTriggersInserted },
              '[promote] new triggers created disabled on production; owner must enable them',
            );
          }
          // Same persistence executeClone and executeUpdate do: a promoted
          // function needing a key it has no value for is what drives the
          // dashboard's "this function needs a secret" banner. Best-effort.
          await controlDb.query(
            `UPDATE template_clone_jobs
                SET unfilled_env_vars = $1::jsonb, updated_at = now()
              WHERE id = $2`,
            [JSON.stringify(fn.unfilledEnvVars), jobId],
          ).catch((err) => {
            logger.warn({ err, jobId }, '[promote] failed to persist unfilled_env_vars summary');
          });
          logger.info(
            { jobId, prodAppId, count: fn.count, warnings: fn.warnings.length },
            '[promote] functions replayed',
          );
          break;
        }

        case 'config': {
          // insertOnly is NOT optional here. Config replay was written for an
          // empty clone target; pointed at a live production app its overwrite
          // branches NULL the OAuth client secret (breaking sign-in on a
          // running app), re-mint the Composio auth config over
          // credentials_encrypted (orphaning every connected end-user account)
          // and replace allowed_origins (dropping the custom domain).
          // Insert-only adds what production lacks and touches nothing it has.
          //
          // skipIntegrations connects the registry's stated policy to the
          // executed behaviour. replayNonSecretConfig calls replayIntegrations
          // internally, but replay-registry declares `integrations` as
          // promotable: false. Nothing moved before only by coincidence — the
          // integrations query filters `WHERE enabled = true` and staging's
          // rows are disabled by isolation. A user who re-enabled an
          // integration on staging would have had a fresh Composio auth config
          // minted against PRODUCTION on the next promote.
          const cfg = await replayNonSecretConfig(
            runtimeDb, runtimeDb, stagingAppId, prodAppId, logger,
            { insertOnly: true, skipIntegrations: true },
          );
          if (cfg.warnings.length > 0) await appendCloneJobWarnings(controlDb, jobId, cfg.warnings);
          break;
        }

        case 'repo': {
          // Publishes the staging app's repo snapshot onto production. Uses
          // the SAME primitives executeClone/executeUpdate use for this
          // (repo-storage.ts blob/manifest copy + setLatest) — there is no
          // single "publish repo" helper to call.
          //
          // job.source_snapshot_id, PINNED AT REQUEST TIME by startPromote
          // (promote-jobs.ts), reading the staging app's apps.repo_latest_snapshot
          // when the promote was requested — not re-read here at execution
          // time (fix round 1). Two reasons this matters, not just style:
          //   1. listActiveCloneSnapshotIdsForApp (clone-jobs.ts) pins every
          //      in-flight job's source_snapshot_id so routes/repo.ts's
          //      retention sweep won't delete a snapshot a job still needs.
          //      A synthetic placeholder pinned nothing — a repo push on
          //      staging while a promote was in flight could delete the very
          //      snapshot this step is about to copy. A real value here is
          //      what makes the pin protect anything.
          //   2. It matches clone/update (both fix the snapshot at request
          //      time) and makes a promote reproducible: it publishes what
          //      the user actually previewed, not whatever staging's HEAD
          //      happens to be whenever the worker reaches this step.
          const snapshotId = job.source_snapshot_id;
          if (!snapshotId) {
            // Deliberate, not an oversight: staging had no repo snapshot at
            // request time (cloned from a repo-less template, or nothing
            // pushed yet). A backend-only promote — schema, RLS, functions,
            // config — is a legitimate thing to want; refusing the whole
            // promote because there is no frontend to publish would be
            // surprising. Record it as a warning and move on. (The
            // 'frontend' case below independently no-ops too — replayFrontend
            // checks its own R2 deploy-artifact slot, which is unrelated to
            // whether a repo snapshot exists.)
            await appendCloneJobWarnings(controlDb, jobId, [
              'Staging has no repo snapshot to publish (nothing has been pushed to its repo yet). '
                + 'Schema, RLS, durable objects, functions and config were still promoted.',
            ]);
            logger.info(
              { jobId, stagingAppId },
              '[promote] job.source_snapshot_id is null; skipping repo publish',
            );
            break;
          }

          const manifestJson = await getManifestJson(stagingAppId, snapshotId);
          if (!manifestJson) {
            // apps.repo_latest_snapshot points at a manifest that isn't in
            // storage — a real inconsistency, not a "nothing to do" case.
            // Fail loudly rather than silently publish nothing while telling
            // the user their repo was promoted.
            throw new Error(
              `[promote] staging repo_latest_snapshot ${snapshotId} has no manifest in storage`,
            );
          }
          const manifest = JSON.parse(manifestJson) as { files: { sha256: string }[] };
          const distinctShas = Array.from(new Set(manifest.files.map((f) => f.sha256)));

          // Staging is pinned to production's region (start-staging.ts /
          // PromoteDeps doc comment above), so this is ALWAYS a same-region
          // copy — no cross-region S3 client branch is needed the way
          // executeUpdate's repo step needs one.
          for (const sha of distinctShas) {
            await copyBlobSameRegion(stagingAppId, prodAppId, sha);
          }
          await copyManifestSameRegion(stagingAppId, prodAppId, snapshotId);
          await setLatest(prodAppId, snapshotId);
          await runtimeDb.query(
            `UPDATE apps SET repo_latest_snapshot = $1, updated_at = now() WHERE id = $2`,
            [snapshotId, prodAppId],
          );
          logger.info(
            { jobId, prodAppId, snapshotId, files: distinctShas.length },
            '[promote] repo snapshot published to production',
          );
          break;
        }

        case 'frontend': {
          // The actual divergence from executeUpdate (see header). Promote
          // deploys, so this is where new code goes live in production — kept
          // LAST in the registry order (with 'repo' immediately above) so
          // everything that can fail (schema, RLS, functions, DOs, config,
          // the repo snapshot) has already landed before production starts
          // serving a new bundle.
          //
          // Shares the 'copying_repo' status with the 'repo' case above (see
          // replay-registry.ts) — setCloneJobStatus is called twice with the
          // same value. Accepted, not a bug: a distinct 'deploying' status
          // would mean widening CloneJobStatus and touching the status column
          // for a purely cosmetic polling gain.
          //
          // replayFrontend (clone-replay.ts) is shared with clone/update and
          // SOFT-FAILS by default there — the backend is already fully
          // replayed on those paths, so a frontend hiccup is a warning, not a
          // failed job. Promote cannot make that trade: the user was told
          // "promote takes staging live", so a deploy failure must fail the
          // whole promote. throwOnFailure is the opt-in escape hatch (same
          // shape as Task 13's preserveDestinationTriggerEnabled /
          // skipIntegrations) — clone and update are byte-for-byte unaffected.
          //
          // WHAT A FAILURE HERE LEAVES BEHIND, BY DESIGN: every step above —
          // schema, RLS, durable objects, functions, config, and now the repo
          // snapshot — has ALREADY been applied to production by the time this
          // runs. A failed deploy therefore leaves production with the NEW
          // backend and repo but the OLD frontend bundle still being served.
          // That is not corruption: the old frontend still talks to a backend
          // that is additive-only (schema) and insert-only (config), so it
          // keeps working. It is surfaced to the user as a failed promote —
          // never as success — and, per the catch block below, this step is
          // itself idempotent (replayFrontend re-copies the same artifact and
          // redeploys), so a retry that reaches this case again simply
          // finishes the job. We do NOT roll back schema/RLS/functions/config
          // on a deploy failure — that would mean destructive DDL against a
          // live production app, which this feature refuses on principle.
          const frontendResult = await replayFrontend(
            controlDb, runtimeDb, stagingAppId, prodAppId, job.requested_by_user_id, logger,
            { throwOnFailure: true },
          );
          if (frontendResult.warnings.length > 0) {
            await appendCloneJobWarnings(controlDb, jobId, frontendResult.warnings);
          }
          logger.info({ jobId, prodAppId }, '[promote] frontend deployed to production');
          break;
        }

        default:
          // A registry row declared promotable with no arm here. Throwing is
          // the point: the user was told this primitive would be promoted, and
          // a warning-and-continue would leave production half-promoted while
          // the job reported success. Fail the whole promote instead.
          throw new Error(
            `[promote] replay-registry declares step '${step.name}' promotable but `
              + 'executePromote has no arm for it; refusing to report a partial promote '
              + 'as complete. Add an arm in execute-promote.ts or set promotable: false '
              + 'with a reason in replay-registry.ts.',
          );
      }
    }

    await touchEnvironmentTimestamp(runtimeDb, prodAppId, 'last_promoted_at');
    await setCloneJobStatus(controlDb, jobId, { status: 'completed', completed_at: new Date() });
    logger.info({ jobId, stagingAppId, prodAppId }, '[promote] completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Same retry contract as executeClone and executeUpdate: only mark the job
    // 'failed' once the neon_tasks queue has exhausted its attempts.
    // 'completed' and 'failed' are the two TERMINAL statuses, and the re-entry
    // guard in executePromoteTask short-circuits on them — so writing 'failed'
    // on attempt 1 of 3 would turn every remaining attempt into a silent no-op
    // and permanently fail a promote that a connection blip would otherwise
    // have let succeed on retry. This is the one mode that writes to a
    // customer's production database; it has more reason to want the retries
    // than any other, not less.
    //
    // WHAT A MID-FLIGHT FAILURE LEAVES BEHIND, BY DESIGN: production can be
    // left with SOME promote steps applied and others not — say schema and RLS
    // landed and functions did not. That is not corruption and not a bug to
    // hunt at 3am. Every step above is idempotent (replaySchema diffs against
    // the destination's CURRENT schema, replayRls tolerates "already exists",
    // functions and durable objects upsert, config is insert-only, the repo
    // publish re-copies the same content-addressed blobs/manifest and
    // re-points 'latest', replayFrontend re-copies the same artifact and
    // redeploys), so simply re-running the promote re-walks the whole list and
    // finishes the job. A retry from the queue does exactly that; so does the
    // owner starting a fresh promote after a permanent failure, because a
    // terminal job frees the idx_template_clone_jobs_one_promote slot.
    //
    // Task 14 extends this same reasoning to the deploy: a promote that fails
    // in the 'frontend' step has already applied schema/RLS/DOs/functions/
    // config/repo to production — a REAL live app, not a fork — and only the
    // deployed bundle is stale. That is deliberately reported as a FAILED
    // promote (see the 'frontend' case above), never as success, so the user
    // is never told production is live when it is still serving the old
    // frontend. We do not attempt to roll schema back to compensate — that
    // would be destructive DDL against a live app, which this feature refuses
    // on principle — and we do not need to: the old frontend keeps working
    // against the new backend (additive schema, insert-only config), and a
    // retry finishes the job the same way every other partial promote does.
    const isPermanent = attempt >= maxAttempts;
    if (isPermanent) {
      await setCloneJobStatus(controlDb, jobId, {
        status: 'failed', error_message: msg, completed_at: new Date(),
      }).catch(() => {});
      logger.error({ err, jobId, stagingAppId, prodAppId }, '[promote] failed');
    } else {
      // Record the error but leave the status non-terminal so the next attempt
      // is allowed to re-enter and finish.
      await setCloneJobStatus(controlDb, jobId, { error_message: msg }).catch(() => {});
      logger.warn(
        { jobId, stagingAppId, prodAppId, attempt, maxAttempts, error: msg },
        '[promote] transient failure, will retry',
      );
    }
    throw err;
  }
}
