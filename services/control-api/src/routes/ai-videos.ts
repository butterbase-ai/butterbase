import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { apiError } from '../utils/api-error.js';
import { isHttpError } from '../services/error-handler.js';
import { requireUserId } from '../utils/require-auth.js';
import { config } from '../config.js';
import { resolveAppHomeRegion, getRuntimeDbForApp } from '../services/region-resolver.js';
import { getRedisClient } from '../services/redis.js';
import {
  routeVideoSubmit, routeVideoPoll, settleVideoJob,
  RouterError, InsufficientCreditsError,
} from '../services/ai-router/router.js';
import { openrouterAdapter } from '../services/ai-router/adapters/openrouter.js';
import type { RouterAdapter } from '../services/ai-router/adapters/types.js';
import type { RouterName } from '../services/ai-router/normalize.js';
import {
  insertVideoJob, getVideoJob, markVideoJobInProgress, markVideoJobTerminal,
  type VideoJobRow,
} from '../services/ai-router/video-jobs.js';
import { settleAfterCall } from '../services/ai-router/billing-gate.js';
import { applyMarkup } from '../services/ai-router/markup.js';
import { readAutoRefillState } from './ai-config.js';

// Reuse the same adapter-build pattern as ai-config.ts. Extract into a shared
// helper if a third route ends up needing it; one duplicate is fine for now.
async function buildAdapters(): Promise<Map<RouterName, RouterAdapter>> {
  const m = new Map<RouterName, RouterAdapter>();
  if (config.aiRouter.openrouterApiKey) {
    m.set('openrouter', openrouterAdapter({ apiKey: config.aiRouter.openrouterApiKey }));
  }
  try {
    // @ts-expect-error overlay resolved at runtime
    const overlay = await import('../../../../cloud-overlays/dist/cloud-overlays/bootstrap.js');
    if (config.aiRouter.providerPrimaryApiKey) {
      m.set('provider-primary', overlay.providerPrimaryAdapter({ apiKey: config.aiRouter.providerPrimaryApiKey }));
    }
    if (config.aiRouter.providerSecondaryApiKey) {
      m.set('provider-secondary', overlay.providerSecondaryAdapter({ apiKey: config.aiRouter.providerSecondaryApiKey }));
    }
  } catch { /* OSS mode */ }
  return m;
}

const videoSubmitSchema = z.object({
  model: z.string(),
  prompt: z.string(),
  duration: z.number().int().positive().optional(),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  generate_audio: z.boolean().optional(),
  seed: z.number().int().optional(),
  input_images: z.array(z.string().url()).optional(),
  input_references: z.array(z.string().url()).optional(),
  provider: z.record(z.unknown()).optional(),
});

export async function aiVideoRoutes(app: FastifyInstance) {
  const adapters = await buildAdapters();

  app.post('/v1/:appId/videos/completions', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);

    try {
      const body = videoSubmitSchema.parse(request.body);
      const region = await resolveAppHomeRegion(app.controlDb, appId);
      const runtimePool = await getRuntimeDbForApp(app.controlDb, appId);

      const submit = await routeVideoSubmit(
        { platformPool: app.controlDb, runtimePool, redis: getRedisClient(),
          adapters, markupPct: config.aiRouter.markupPct,
          appId, userId, region },
        body,
      );

      let jobId: string;
      try {
        jobId = await insertVideoJob(runtimePool, {
          appId, userId, model: body.model, requestJson: body,
          upstreamRouter: submit.chosenRouter,
          upstreamJobId: submit.upstreamJobId,
          upstreamPollingUrl: submit.pollingUrl,
          leaseId: submit.leaseId,
          estimatedCostUsd: submit.estimatedCostUsd,
          markupPct: config.aiRouter.markupPct,
        });
      } catch (insertErr) {
        // Upstream job is running but we have no row to track it. Refund the lease
        // (synthetic handle is safe — settleAfterCall reads only leaseId), and log
        // loudly so ops can reconcile the orphaned upstream job.
        await settleAfterCall(
          app.controlDb,
          { leaseId: submit.leaseId, amountGrantedUsd: 0, expiresAt: new Date() },
          0,
        ).catch(refundErr => {
          app.log.error({ err: refundErr, leaseId: submit.leaseId }, 'video: lease refund after insert failure also failed');
        });
        app.log.error({
          err: insertErr,
          appId, userId,
          upstreamRouter: submit.chosenRouter,
          upstreamJobId: submit.upstreamJobId,
        }, 'video: insertVideoJob failed AFTER upstream submit — orphaned upstream job');
        throw insertErr; // surface as 500 via handleVideoError
      }

      const publicPollingUrl = `${request.protocol}://${request.hostname}/v1/${appId}/videos/completions/${jobId}`;
      return reply.code(202).send({ job_id: jobId, status: 'pending', polling_url: publicPollingUrl });
    } catch (error) {
      return handleVideoError(app, reply, userId, error);
    }
  });

  app.get('/v1/:appId/videos/completions/:jobId', async (request, reply) => {
    const { appId, jobId } = request.params as { appId: string; jobId: string };
    const userId = requireUserId(request);

    try {
      const runtimePool = await getRuntimeDbForApp(app.controlDb, appId);
      const job = await getVideoJob(runtimePool, jobId);
      if (!job || job.app_id !== appId) return reply.code(404).send({ error: 'job_not_found', code: 'JOB_NOT_FOUND' });
      if (job.user_id !== userId) return reply.code(403).send({ error: 'forbidden', code: 'FORBIDDEN' });

      const absoluteBase = `${request.protocol}://${request.hostname}`;

      if (['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) {
        return reply.code(200).send(buildPublicJobResponse(absoluteBase, appId, job));
      }

      const region = await resolveAppHomeRegion(app.controlDb, appId);
      const ctx = {
        platformPool: app.controlDb, runtimePool, redis: getRedisClient(),
        adapters, markupPct: parseFloat(job.markup_pct),
        appId, userId, region,
      };
      const poll = await routeVideoPoll(ctx, job.upstream_router as RouterName, job.upstream_polling_url);

      if (poll.status === 'in_progress' && job.status === 'pending') {
        await markVideoJobInProgress(runtimePool, jobId);
      }

      if (['completed', 'failed', 'cancelled', 'expired'].includes(poll.status)) {
        const providerCost = poll.providerCostUsd ?? 0;

        // Mark terminal FIRST — atomic gate. Only the "winner" of this row update
        // settles the lease + writes the usage row.
        const terminal = await markVideoJobTerminal(runtimePool, jobId, {
          status: poll.status as 'completed' | 'failed' | 'cancelled' | 'expired',
          unsignedUrls: poll.unsignedUrls,
          providerCostUsd: providerCost,
          // chargedCreditsUsd is computed below if we're the winner; pass through
          // a tentative value matching what settleVideoJob would compute so the
          // row reflects the same number whether we settle or not.
          chargedCreditsUsd: applyMarkup(providerCost, parseFloat(job.markup_pct)),
          error: poll.error,
        });

        if (terminal.firstTerminal) {
          await settleVideoJob(ctx, {
            leaseId: job.lease_id,
            chosenRouter: job.upstream_router as RouterName,
            canonicalModel: job.model,
            providerCostUsd: providerCost,
          });
        }

        const fresh = await getVideoJob(runtimePool, jobId);
        return reply.code(200).send(buildPublicJobResponse(absoluteBase, appId, fresh!));
      }

      return reply.code(200).send({
        job_id: jobId,
        status: poll.status,
        polling_url: `${absoluteBase}/v1/${appId}/videos/completions/${jobId}`,
      });
    } catch (error) {
      return handleVideoError(app, reply, userId, error);
    }
  });

  app.get('/v1/:appId/videos/completions/:jobId/content', async (request, reply) => {
    const { appId, jobId } = request.params as { appId: string; jobId: string };
    const userId = requireUserId(request);
    const index = parseInt((request.query as { index?: string }).index ?? '0', 10);

    try {
      const runtimePool = await getRuntimeDbForApp(app.controlDb, appId);
      const job = await getVideoJob(runtimePool, jobId);
      if (!job || job.app_id !== appId) return reply.code(404).send({ error: 'job_not_found', code: 'JOB_NOT_FOUND' });
      if (job.user_id !== userId) return reply.code(403).send({ error: 'forbidden', code: 'FORBIDDEN' });
      if (job.status !== 'completed') {
        return reply.code(409).send({ error: 'job_not_completed', code: 'JOB_NOT_COMPLETED', current_status: job.status });
      }

      const adapter = adapters.get(job.upstream_router as RouterName);
      if (!adapter?.fetchVideoContent) {
        return reply.code(502).send({ error: 'content_unavailable', code: 'CONTENT_UNAVAILABLE' });
      }
      const { stream, contentType } = await adapter.fetchVideoContent(job.upstream_job_id, index);
      return reply
        .code(200)
        .header('Content-Type', contentType)
        .send(Readable.fromWeb(stream as any));
    } catch (error) {
      return handleVideoError(app, reply, userId, error);
    }
  });
}

export function buildPublicJobResponse(absoluteBase: string, appId: string, job: VideoJobRow) {
  const base = `${absoluteBase}/v1/${appId}/videos/completions/${job.id}`;
  return {
    job_id: job.id,
    status: job.status,
    model: job.model,
    polling_url: base,
    content_urls: job.unsigned_urls
      ? job.unsigned_urls.map((_, i) => `${base}/content?index=${i}`)
      : null,
    error: job.error,
    created_at: job.created_at,
  };
}

export async function handleVideoError(app: FastifyInstance, reply: any, userId: string, error: unknown) {
  if (error instanceof InsufficientCreditsError) {
    const ar = await readAutoRefillState(app.controlDb, userId).catch(() => ({
      enabled: false, amountUsd: null, monthlyAllowanceUsd: 0, topupUsd: 0,
    }));
    return reply.code(402).send({
      error: 'insufficient_credits',
      code: 'INSUFFICIENT_CREDITS',
      required_usd: error.requiredUsd,
      available_usd: error.availableUsd,
      monthly_allowance_usd: ar.monthlyAllowanceUsd,
      credits_usd: ar.topupUsd,
      auto_refill_enabled: ar.enabled,
      auto_refill_amount_usd: ar.amountUsd,
    });
  }
  if (error instanceof RouterError) {
    app.log.warn({ err: error, attempted: error.attempted, internalCode: error.code }, 'Video request failed');
    const publicCode = error.code === 'MODEL_NOT_FOUND' ? 'MODEL_NOT_FOUND'
      : error.code === 'WRONG_MODALITY' ? 'WRONG_MODALITY'
      : 'MODEL_UNAVAILABLE';
    return reply.code(error.statusCode).send({ error: error.message, code: publicCode });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: 'Invalid request', details: error.errors });
  }
  if (isHttpError(error)) throw error;
  app.log.error({ err: error }, 'Failed to process video request');
  return reply.code(500).send(apiError(error, 'Failed to process video request'));
}
