import type { FastifyPluginAsync } from 'fastify';
import {
  reconcileStagingLinks, optionsFromEnv,
} from '../../services/staging-link-reconciler.js';

const stagingLinkReconcilerRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /v1/internal/reconcile-staging-links
   *
   * Finds staging apps that were fully provisioned but never got their
   * `app_environments` row — the failure mode the clone worker's
   * "backfill will repair" comment referred to, for which no backfill existed.
   *
   * DRY-RUN BY DEFAULT, like the neon orphan reconciler. Set
   * BUTTERBASE_STAGING_RELINK_DRY_RUN=false to let it actually write links, or
   * pass `{"apply": true}` to override for a single run. A run that only
   * reports still returns everything it would have done in `wouldRelink`, plus
   * the `flagged` list of candidates that need a human.
   *
   * Auth: internal-auth plugin gates every /v1/internal/* path via
   * BUTTERBASE_INTERNAL_SECRET header.
   */
  fastify.post('/v1/internal/reconcile-staging-links', async (request) => {
    const body = (request.body ?? {}) as { apply?: unknown };
    const opts = optionsFromEnv();
    // `apply` may only ever turn the dry run OFF explicitly; it is never read
    // as a way to turn a configured live sweep back into a dry run silently.
    if (body.apply === true) opts.dryRun = false;

    const report = await reconcileStagingLinks(fastify.controlDb, fastify.log, opts);
    fastify.log.info({ report }, '[staging-link-reconciler] reconciliation complete');
    return report;
  });
};

export default stagingLinkReconcilerRoutes;
