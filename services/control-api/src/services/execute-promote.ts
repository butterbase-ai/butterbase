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
 */
import type pg from 'pg';
import {
  replaySchema,
  replayRls,
  replayFunctions,
  replayNonSecretConfig,
} from './clone-replay.js';
import { replayDurableObjectsForClone } from './durable-objects.service.js';
import { filterAdditive } from './schema-additive-filter.js';
import { setCloneJobStatus, appendCloneJobWarnings, type CloneJob } from './clone-jobs.js';
import { touchEnvironmentTimestamp } from './app-environments.js';
import { promotableSteps } from './replay-registry.js';

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
  logger: PromoteLogger;
}

export async function executePromote(deps: PromoteDeps, job: CloneJob): Promise<void> {
  const { controlDb, runtimeDb, stagingPool, prodPool, prodOwnerId, logger } = deps;
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
          // Policies production already has make CREATE POLICY fail with
          // "already exists"; those are expected no-ops on a live app and are
          // filtered out rather than shown to the owner as problems.
          const rls = await replayRls(stagingPool, prodPool, logger);
          const warnings = rls.warnings.filter((w) => !/already exists/i.test(w));
          if (warnings.length > 0) await appendCloneJobWarnings(controlDb, jobId, warnings);
          logger.info(
            { jobId, prodAppId, replayed: rls.replayed, warnings: warnings.length },
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
          const fn = await replayFunctions(
            runtimeDb, runtimeDb, stagingAppId, prodAppId, job.requested_by_user_id, logger,
            { overwriteExisting: true, controlPool: controlDb, destAppOwnerId: prodOwnerId },
          );
          if (fn.warnings.length > 0) await appendCloneJobWarnings(controlDb, jobId, fn.warnings);
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
          const cfg = await replayNonSecretConfig(
            runtimeDb, runtimeDb, stagingAppId, prodAppId, logger, { insertOnly: true },
          );
          if (cfg.warnings.length > 0) await appendCloneJobWarnings(controlDb, jobId, cfg.warnings);
          break;
        }

        case 'repo':
        case 'frontend':
          // Deliberate, explicit no-op. Task 14 owns publishing the staging
          // repo snapshot onto production and redeploying the frontend; both
          // need S3 blob copying and the deploy pipeline, neither of which
          // belongs in this module. Named here rather than left to the default
          // arm so that "not yet implemented" and "nobody wired this" are
          // different states in the code.
          logger.info(
            { jobId, prodAppId, step: step.name },
            '[promote] repo/frontend promotion is implemented by Task 14; skipping here',
          );
          break;

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
    await setCloneJobStatus(controlDb, jobId, {
      status: 'failed', error_message: msg, completed_at: new Date(),
    }).catch(() => {});
    logger.error({ err, jobId, stagingAppId, prodAppId }, '[promote] failed');
    throw err;
  }
}
