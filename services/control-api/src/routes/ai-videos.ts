import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { apiError } from '../utils/api-error.js';
import { isHttpError } from '../services/error-handler.js';
import { authorizeAppAiCall } from '../services/ai-router/authorize-app-call.js';
import { config } from '../config.js';
import { resolveAppHomeRegion, getRuntimeDbForApp } from '../services/region-resolver.js';
import { getRedisClient } from '../services/redis.js';
import { resolveOrgFromApp } from '../services/app-org-resolver.js';
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
import { settleAfterCall, insufficientCreditsFields } from '../services/ai-router/billing-gate.js';
import { applyMarkup } from '../services/ai-router/markup.js';
import { readAutoRefillState } from './ai-config.js';
import { resolveMarkupPct, type MarkupSource } from '../services/ai-router/special-pricing.js';

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

const IMAGE_ALIAS_KEYS = [
  'image',
  'image_url',
  'image_uri',
  'first_frame',
  'reference_image',
  'input_image',
  'starting_image',
] as const;

/**
 * Mirror canonical `input_images` URL strings onto `frame_images`, the object
 * shape some upstreams require for image-to-video:
 *   `{ type: 'image_url', image_url: { url }, frame_type }`
 *
 * Why this lives in normalization and not in an adapter: adapters forward the
 * body verbatim, so an upstream that only understands `frame_images` silently
 * ignored `input_images` and returned a text-to-video result — no error, full
 * charge, wrong video. Deriving the mirror here means the canonical shape keeps
 * working for every router while adapters stay pure passthrough.
 *
 * `input_images` is deliberately left in place: routers that consume the
 * canonical form still read it, and routers that don't ignore unknown keys.
 *
 * Positional mapping only — first URL is the opening frame, second is the
 * closing frame. Three or more frames have no unambiguous positional reading,
 * so no mirror is derived; such callers must send `frame_images` (or
 * `input_references`) explicitly.
 */
function deriveFrameImages(urls: string[]): Array<Record<string, unknown>> | null {
  if (urls.length === 0 || urls.length > 2) return null;
  return urls.map((url, i) => ({
    type: 'image_url',
    image_url: { url },
    frame_type: i === 0 ? 'first_frame' : 'last_frame',
  }));
}

export const videoSubmitSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const src = raw as Record<string, unknown>;
  const aliased: string[] = [];
  for (const key of IMAGE_ALIAS_KEYS) {
    const v = src[key];
    if (typeof v === 'string' && v.length > 0) aliased.push(v);
    else if (Array.isArray(v)) for (const item of v) if (typeof item === 'string' && item.length > 0) aliased.push(item);
  }
  const next = { ...src };
  if (aliased.length > 0) {
    for (const key of IMAGE_ALIAS_KEYS) delete next[key];
    const existing = Array.isArray(next.input_images) ? (next.input_images as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    next.input_images = [...existing, ...aliased];
  }

  // An explicit frame_images from the caller always wins — never overwrite it.
  if (next.frame_images === undefined && Array.isArray(next.input_images)) {
    const urls = (next.input_images as unknown[]).filter((x): x is string => typeof x === 'string');
    const derived = deriveFrameImages(urls);
    if (derived) next.frame_images = derived;
  }
  return next;
}, z.object({
  model: z.string(),
  prompt: z.string(),
  duration: z.number().int().positive().optional(),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  generate_audio: z.boolean().optional(),
  seed: z.number().int().optional(),
  input_images: z.array(z.string().url()).optional(),
  // Seed imagery may be supplied either as flat URL strings (canonical shape,
  // translated by adapters that need it) or in the upstream's own object shape
  // — `{ type: 'image_url', image_url: { url }, frame_type? }`. Object entries
  // are forwarded verbatim without inspection, so callers targeting a specific
  // upstream can use its native vocabulary.
  input_references: z.array(z.union([z.string().url(), z.record(z.unknown())])).optional(),
  frame_images: z.array(z.record(z.unknown())).optional(),
  provider: z.record(z.unknown()).optional(),
}).strict());

export async function aiVideoRoutes(app: FastifyInstance) {
  const adapters = await buildVideoAdapters();

  app.post('/v1/:appId/videos/completions', async (request, reply) => {
    const { appId } = request.params as { appId: string };

    const authz = await authorizeAppAiCall(app.controlDb, appId, request);
    if (!authz.ok) return reply.code(authz.status).send(authz.body);
    const ownerId = authz.ownerId;
    const endUserSub = authz.caller.kind === 'end_user' ? authz.caller.sub : null;

    const runtimePool = await getRuntimeDbForApp(app.controlDb, appId);
    const organizationId = await resolveOrgFromApp(runtimePool, appId);

    try {
      const body = videoSubmitSchema.parse(request.body);
      const { pct: markupPct, source: markupSource } = await resolveMarkupPct(app.controlDb, organizationId, body.model);
      const region = await resolveAppHomeRegion(app.controlDb, appId);

      const submit = await routeVideoSubmit(
        { platformPool: app.controlDb, runtimePool, redis: getRedisClient(),
          adapters, markupPct, markupSource,
          appId, organizationId, userId: ownerId, region },
        body,
      );

      let jobId: string;
      try {
        jobId = await insertVideoJob(runtimePool, {
          appId, userId: ownerId, endUserSub, model: body.model, requestJson: body,
          upstreamRouter: submit.chosenRouter,
          upstreamJobId: submit.upstreamJobId,
          upstreamPollingUrl: submit.pollingUrl,
          leaseId: submit.leaseId,
          estimatedCostUsd: submit.estimatedCostUsd,
          markupPct,
          markupSource,
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
          appId, ownerId,
          upstreamRouter: submit.chosenRouter,
          upstreamJobId: submit.upstreamJobId,
        }, 'video: insertVideoJob failed AFTER upstream submit — orphaned upstream job');
        throw insertErr; // surface as 500 via handleVideoError
      }

      const publicPollingUrl = `${publicProto(request)}://${publicHost(request)}/v1/${appId}/videos/completions/${jobId}`;
      return reply.code(202).send({ job_id: jobId, status: 'pending', polling_url: publicPollingUrl });
    } catch (error) {
      return handleVideoError(app, reply, organizationId, error);
    }
  });

  app.get('/v1/:appId/videos/completions/:jobId', async (request, reply) => {
    const { appId, jobId } = request.params as { appId: string; jobId: string };

    // Same authz model as POST — owner / end-user JWT / app-scoped key.
    // Per-end-user isolation is enforced on the row below.
    const authz = await authorizeAppAiCall(app.controlDb, appId, request);
    if (!authz.ok) return reply.code(authz.status).send(authz.body);
    const ownerId = authz.ownerId;

    const runtimePool = await getRuntimeDbForApp(app.controlDb, appId);
    const organizationId = await resolveOrgFromApp(runtimePool, appId);

    try {
      const job = await getVideoJob(runtimePool, jobId);
      if (!job || job.app_id !== appId) return reply.code(404).send({ error: 'job_not_found', code: 'JOB_NOT_FOUND' });
      // End-users can only see jobs they submitted themselves. 404 (not 403)
      // because revealing existence would leak that *some* other user owns it.
      if (authz.caller.kind === 'end_user' && job.end_user_sub !== authz.caller.sub) {
        return reply.code(404).send({ error: 'job_not_found', code: 'JOB_NOT_FOUND' });
      }

      const absoluteBase = `${publicProto(request)}://${publicHost(request)}`;

      if (['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) {
        return reply.code(200).send(buildPublicJobResponse(absoluteBase, appId, job));
      }

      const region = await resolveAppHomeRegion(app.controlDb, appId);
      const ctx: RouteContext = {
        platformPool: app.controlDb, runtimePool, redis: getRedisClient(),
        adapters, markupPct: parseFloat(job.markup_pct),
        markupSource: (job.markup_source ?? 'global') as MarkupSource,
        appId, organizationId, userId: ownerId, region,
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
      return handleVideoError(app, reply, organizationId, error);
    }
  });

  app.get('/v1/:appId/videos/completions/:jobId/content', async (request, reply) => {
    const { appId, jobId } = request.params as { appId: string; jobId: string };

    const authz = await authorizeAppAiCall(app.controlDb, appId, request);
    if (!authz.ok) return reply.code(authz.status).send(authz.body);
    const ownerId = authz.ownerId;

    const index = parseInt((request.query as { index?: string }).index ?? '0', 10);
    if (Number.isNaN(index) || index < 0) {
      return reply.code(400).send({
        error: 'invalid_index',
        code: 'INVALID_INDEX',
        message: 'index query parameter must be a non-negative integer',
      });
    }

    const runtimePool = await getRuntimeDbForApp(app.controlDb, appId);
    const organizationId = await resolveOrgFromApp(runtimePool, appId);

    try {
      const job = await getVideoJob(runtimePool, jobId);
      if (!job || job.app_id !== appId) return reply.code(404).send({ error: 'job_not_found', code: 'JOB_NOT_FOUND' });
      if (authz.caller.kind === 'end_user' && job.end_user_sub !== authz.caller.sub) {
        return reply.code(404).send({ error: 'job_not_found', code: 'JOB_NOT_FOUND' });
      }
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
      return handleVideoError(app, reply, organizationId, error);
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

export async function handleVideoError(app: FastifyInstance, reply: any, organizationId: string, error: unknown) {
  if (error instanceof InsufficientCreditsError) {
    const ar = await readAutoRefillState(app.controlDb, organizationId).catch(() => ({
      enabled: false, amountUsd: null, monthlyAllowanceUsd: 0, topupUsd: 0,
    }));
    return reply.code(402).send({
      error: 'insufficient_credits',
      code: 'INSUFFICIENT_CREDITS',
      ...insufficientCreditsFields(error),
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
