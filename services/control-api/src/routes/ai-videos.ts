import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { apiError } from '../utils/api-error.js';
import { isHttpError } from '../services/error-handler.js';
import { requireUserId } from '../utils/require-auth.js';
import { config } from '../config.js';
import { resolveAppHomeRegion, getRuntimeDbForApp } from '../services/region-resolver.js';
import { getRedisClient } from '../services/redis.js';
import {
  routeVideoSubmit, routeVideoPoll, settleVideoJob,
  billedVideoCostUsd,
  RouterError, InsufficientCreditsError,
  type RouteContext,
} from '../services/ai-router/router.js';
import { readCatalogEntry } from '../services/ai-router/catalog.js';
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

// Public URLs returned to clients must honor the X-Forwarded-* headers that
// Traefik (dev) and Fly's edge (prod) set, since Fastify's trustProxy is off
// globally. Without these helpers, polling_url and content_urls would render
// `http://api.butterbase.ai/...` even though the request came in over HTTPS.
function publicProto(request: FastifyRequest): string {
  const xfp = request.headers['x-forwarded-proto'];
  if (typeof xfp === 'string' && xfp) return xfp.split(',')[0].trim();
  if (Array.isArray(xfp) && xfp[0]) return xfp[0].trim();
  return request.protocol;
}
function publicHost(request: FastifyRequest): string {
  const xfh = request.headers['x-forwarded-host'];
  if (typeof xfh === 'string' && xfh) return xfh.split(',')[0].trim();
  if (Array.isArray(xfh) && xfh[0]) return xfh[0].trim();
  return request.hostname;
}

// Reuse the same adapter-build pattern as ai-config.ts. Exported so the
// video sweeper can reuse the exact same set of routers without duplicating
// the overlay-import dance.
export async function buildVideoAdapters(): Promise<Map<RouterName, RouterAdapter>> {
  const m = new Map<RouterName, RouterAdapter>();
  if (config.aiRouter.openrouterApiKey) {
    m.set('openrouter', openrouterAdapter({ apiKey: config.aiRouter.openrouterApiKey }));
  }
  try {
    // @ts-expect-error overlay resolved at runtime
    const overlay = await import('../../../../cloud-overlays/dist/cloud-overlays/bootstrap.js');
    if (config.aiRouter.providerPrimaryApiKey) {
      m.set('provider-primary', overlay.providerPrimaryAdapter({
        apiKey: config.aiRouter.providerPrimaryApiKey,
        baseUrl: config.aiRouter.providerPrimaryBaseUrl,
      }));
    }
    if (config.aiRouter.providerSecondaryApiKey) {
      m.set('provider-secondary', overlay.providerSecondaryAdapter({
        apiKey: config.aiRouter.providerSecondaryApiKey,
        baseUrl: config.aiRouter.providerSecondaryBaseUrl,
        catalogUrl: config.aiRouter.providerSecondaryCatalogUrl,
      }));
    }
    if (config.aiRouter.providerTertiaryApiKey) {
      m.set('provider-tertiary', overlay.providerTertiaryAdapter({
        apiKey: config.aiRouter.providerTertiaryApiKey,
        baseUrl: config.aiRouter.providerTertiaryBaseUrl,
      }));
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
  const adapters = await buildVideoAdapters();

  app.post('/v1/:appId/videos/completions', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);

    try {
      // Authorize caller and resolve billing identity — bill the app owner, not the caller.
      // See ai-config.ts (chat completions) for the rationale.
      const ownerResult = await app.controlDb.query<{ owner_id: string }>(
        'SELECT owner_id FROM apps WHERE id = $1',
        [appId]
      );
      if (ownerResult.rows.length === 0) {
        return reply.code(404).send({ error: 'app_not_found', code: 'APP_NOT_FOUND' });
      }
      const ownerId = ownerResult.rows[0].owner_id;
      if (ownerId !== userId) {
        return reply.code(403).send({ error: 'forbidden', code: 'FORBIDDEN' });
      }

      const body = videoSubmitSchema.parse(request.body);
      const region = await resolveAppHomeRegion(app.controlDb, appId);
      const runtimePool = await getRuntimeDbForApp(app.controlDb, appId);

      const submit = await routeVideoSubmit(
        { platformPool: app.controlDb, runtimePool, redis: getRedisClient(),
          adapters, markupPct: config.aiRouter.markupPct,
          appId, userId: ownerId, region },
        body,
      );

      let jobId: string;
      try {
        jobId = await insertVideoJob(runtimePool, {
          appId, userId: ownerId, model: body.model, requestJson: body,
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

      const publicPollingUrl = `${publicProto(request)}://${publicHost(request)}/v1/${appId}/videos/completions/${jobId}`;
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

      const absoluteBase = `${publicProto(request)}://${publicHost(request)}`;

      if (['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) {
        return reply.code(200).send(buildPublicJobResponse(absoluteBase, appId, job));
      }

      const region = await resolveAppHomeRegion(app.controlDb, appId);
      const ctx: RouteContext = {
        platformPool: app.controlDb, runtimePool, redis: getRedisClient(),
        adapters, markupPct: parseFloat(job.markup_pct),
        appId, userId, region,
      };
      const result = await pollAndSettleVideoJob(ctx, job);

      if (result.terminal) {
        const fresh = await getVideoJob(runtimePool, jobId);
        return reply.code(200).send(buildPublicJobResponse(absoluteBase, appId, fresh!));
      }
      return reply.code(200).send({
        job_id: jobId,
        status: result.status,
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
    if (Number.isNaN(index) || index < 0) {
      return reply.code(400).send({
        error: 'invalid_index',
        code: 'INVALID_INDEX',
        message: 'index query parameter must be a non-negative integer',
      });
    }

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

/**
 * Poll the upstream for a video job and, if terminal, settle the lease + mark
 * the row. Shared between the customer GET handler and the server-side
 * sweeper. Caller supplies the RouteContext (with adapters + pools + redis).
 * Returns the upstream poll status and whether the row reached terminal here.
 */
export async function pollAndSettleVideoJob(
  ctx: RouteContext,
  job: VideoJobRow,
): Promise<{ status: string; terminal: boolean }> {
  const poll = await routeVideoPoll(ctx, job.upstream_router as RouterName, job.upstream_polling_url);

  if (poll.status === 'in_progress' && job.status === 'pending') {
    await markVideoJobInProgress(ctx.runtimePool, job.id);
  }

  if (!['completed', 'failed', 'cancelled', 'expired'].includes(poll.status)) {
    return { status: poll.status, terminal: false };
  }

  // Settlement cost resolution:
  //   1) upstream's reported per-job cost (poll.providerCostUsd), or
  //   2) billedVideoCostUsd — pins to the chosen router's variants and
  //      matches the submit-time request (resolution + visual-input mode).
  //   3) $0 as final guard — only `failed`/`cancelled` paths, where
  //      charging would be wrong anyway.
  let providerCost = poll.providerCostUsd ?? 0;
  if (poll.providerCostUsd === undefined && poll.status === 'completed') {
    const entry = await readCatalogEntry(ctx.redis, job.model);
    if (entry) {
      const billed = billedVideoCostUsd(
        entry,
        job.request_json as unknown as import('../services/ai-router/adapters/types.js').VideoGenerationRequest,
        job.upstream_router as RouterName,
      );
      if (billed !== null) providerCost = billed;
    }
  }

  const terminal = await markVideoJobTerminal(ctx.runtimePool, job.id, {
    status: poll.status as 'completed' | 'failed' | 'cancelled' | 'expired',
    unsignedUrls: poll.unsignedUrls,
    providerCostUsd: providerCost,
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
  return { status: poll.status, terminal: true };
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
    // Charged amount is null until the first terminal poll has settled the lease.
    charged_credits_usd: job.charged_credits_usd != null ? parseFloat(job.charged_credits_usd) : null,
    settled_at: job.settled_at,
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
