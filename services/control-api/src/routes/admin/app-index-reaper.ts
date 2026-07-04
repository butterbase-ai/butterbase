import type { FastifyPluginAsync } from 'fastify';
import { reapAppIndex } from '../../services/app-index-reaper.js';

const appIndexReaperRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /v1/internal/reap-app-index
   *
   * Reconciles org_app_index (control DB) with every region's apps table.
   * Auto-fixes three classes of drift: orphan index entries (no apps row in
   * any region), missing index entries (apps row but no index), and wrong-
   * region entries (index points at the wrong region).
   *
   * Idempotent. Safe to run while serving traffic. Called daily by the
   * cron-scheduler — see services/cron-scheduler/src/index.ts.
   *
   * Auth: internal-auth plugin gates every /v1/internal/* path via
   * BUTTERBASE_INTERNAL_SECRET header.
   */
  fastify.post('/v1/internal/reap-app-index', async () => {
    const report = await reapAppIndex(fastify.controlDb);
    fastify.log.info({ report }, '[app-index-reaper] reconciliation complete');
    return report;
  });
};

export default appIndexReaperRoutes;
