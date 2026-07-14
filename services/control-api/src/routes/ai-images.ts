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
  routeImageSubmit, routeImagePoll, settleImageJob,
  billedImageCostUsd,
  RouterError, InsufficientCreditsError,
  type RouteContext,
} from '../services/ai-router/router.js';
import { readCatalogEntry } from '../services/ai-router/catalog.js';
import { openrouterAdapter } from '../services/ai-router/adapters/openrouter.js';
import type { RouterAdapter } from '../services/ai-router/adapters/types.js';
import type { RouterName } from '../services/ai-router/normalize.js';
import {
  insertImageJob, getImageJob, markImageJobInProgress, markImageJobTerminal,
  type ImageJobRow,
} from '../services/ai-router/image-jobs.js';
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

// Reuse the same adapter-build pattern as ai-config.ts / ai-videos.ts. Exported
// so a future image sweeper can reuse the exact same set of routers without
// duplicating the overlay-import dance.
export async function buildImageAdapters(): Promise<Map<RouterName, RouterAdapter>> {
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

// Note: `mask` is intentionally NOT in the alias list — it's a semantically
// distinct GPT Image 2 edit mask, not just another reference image.
const IMAGE_ALIAS_KEYS = [
  'image',
  'image_url',
  'image_uri',
  'reference_image',
  'input_image',
  'starting_image',
] as const;

export const imageSubmitSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const src = raw as Record<string, unknown>;
  const aliased: string[] = [];
  for (const key of IMAGE_ALIAS_KEYS) {
    const v = src[key];
    if (typeof v === 'string' && v.length > 0) aliased.push(v);
    else if (Array.isArray(v)) for (const item of v) if (typeof item === 'string' && item.length > 0) aliased.push(item);
  }
  if (aliased.length === 0) return raw;
  const next = { ...src };
  for (const key of IMAGE_ALIAS_KEYS) delete next[key];
  const existing = Array.isArray(next.input_images) ? (next.input_images as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  next.input_images = [...existing, ...aliased];
  return next;
}, z.object({
  model: z.string(),
  prompt: z.string().min(1),
  size: z.string().optional(),
  aspect_ratio: z.string().optional(),
  n: z.number().int().positive().max(10).optional(),
  seed: z.number().int().optional(),
  negative_prompt: z.string().optional(),
  input_images: z.array(z.string().url()).max(14).optional(),
  mask: z.string().url().optional(),
  provider: z.record(z.unknown()).optional(),
}).strict());

export async function aiImageRoutes(app: FastifyInstance) {
  const adapters = await buildImageAdapters();

  app.post('/v1/:appId/images/completions', async (request, reply) => {
    const { appId } = request.params as { appId: string };

    const authz = await authorizeAppAiCall(app.controlDb, appId, request);
    if (!authz.ok) return reply.code(authz.status).send(authz.body);
    const ownerId = authz.ownerId;
    const endUserSub = authz.caller.kind === 'end_user' ? authz.caller.sub : null;

    const runtimePool = await getRuntimeDbForApp(app.controlDb, appId);
    const organizationId = await resolveOrgFromApp(runtimePool, appId);

    try {
      const body = imageSubmitSchema.parse(request.body);

      const unsupported = validateImageParams(body, adapters);
      if (unsupported) return reply.code(400).send(unsupported);

      const region = await resolveAppHomeRegion(app.controlDb, appId);

      const submit = await routeImageSubmit(
        { platformPool: app.controlDb, runtimePool, redis: getRedisClient(),
          adapters, markupPct: config.aiRouter.markupPct,
          appId, organizationId, userId: ownerId, region },
        body,
      );

      let jobId: string;
      try {
        jobId = await insertImageJob(runtimePool, {
          appId, userId: ownerId, endUserSub, model: body.model, requestJson: body,
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
          app.log.error({ err: refundErr, leaseId: submit.leaseId }, 'image: lease refund after insert failure also failed');
        });
        app.log.error({
          err: insertErr,
          appId, ownerId,
          upstreamRouter: submit.chosenRouter,
          upstreamJobId: submit.upstreamJobId,
        }, 'image: insertImageJob failed AFTER upstream submit — orphaned upstream job');
        throw insertErr; // surface as 500 via handleImageError
      }

      // Sync-inline settle path (OpenRouter): the upstream already returned a
      // terminal state on submit. Mark the row terminal + settle the lease BEFORE
      // the 202 reply so the client's very first GET returns `completed`.
      // Per the always-202 contract, we still respond 202 with status:"pending".
      if (submit.terminalInline) {
        const inline = submit.terminalInline;
        const cost = inline.providerCostUsd ?? 0;
        await markImageJobTerminal(runtimePool, jobId, {
          status: inline.status,
          unsignedUrls: inline.unsignedUrls,
          contentType: inline.contentType,
          providerCostUsd: cost,
          chargedCreditsUsd: applyMarkup(cost, config.aiRouter.markupPct),
          error: inline.error,
        });
        await settleImageJob(
          { platformPool: app.controlDb, runtimePool, redis: getRedisClient(),
            adapters, markupPct: config.aiRouter.markupPct,
            appId, organizationId, userId: ownerId, region },
          { leaseId: submit.leaseId, chosenRouter: submit.chosenRouter, canonicalModel: body.model, providerCostUsd: cost },
        );
      }

      const publicPollingUrl = `${publicProto(request)}://${publicHost(request)}/v1/${appId}/images/completions/${jobId}`;
      return reply.code(202).send({ job_id: jobId, status: 'pending', polling_url: publicPollingUrl });
    } catch (error) {
      return handleImageError(app, reply, organizationId, error);
    }
  });

  app.get('/v1/:appId/images/completions/:jobId', async (request, reply) => {
    const { appId, jobId } = request.params as { appId: string; jobId: string };

    // Same authz model as POST — owner / end-user JWT / app-scoped key.
    // Per-end-user isolation is enforced on the row below.
    const authz = await authorizeAppAiCall(app.controlDb, appId, request);
    if (!authz.ok) return reply.code(authz.status).send(authz.body);
    const ownerId = authz.ownerId;

    const runtimePool = await getRuntimeDbForApp(app.controlDb, appId);
    const organizationId = await resolveOrgFromApp(runtimePool, appId);

    try {
      const job = await getImageJob(runtimePool, jobId);
      if (!job || job.app_id !== appId) return reply.code(404).send({ error: 'job_not_found', code: 'JOB_NOT_FOUND' });
      // End-users can only see jobs they submitted themselves. 404 (not 403)
      // because revealing existence would leak that *some* other user owns it.
      if (authz.caller.kind === 'end_user' && job.end_user_sub !== authz.caller.sub) {
        return reply.code(404).send({ error: 'job_not_found', code: 'JOB_NOT_FOUND' });
      }

      const absoluteBase = `${publicProto(request)}://${publicHost(request)}`;

      if (['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) {
        return reply.code(200).send(buildPublicImageJobResponse(absoluteBase, appId, job));
      }

      const region = await resolveAppHomeRegion(app.controlDb, appId);
      const ctx: RouteContext = {
        platformPool: app.controlDb, runtimePool, redis: getRedisClient(),
        adapters, markupPct: parseFloat(job.markup_pct),
        appId, organizationId, userId: ownerId, region,
      };
      const result = await pollAndSettleImageJob(ctx, job);

      if (result.terminal) {
        const fresh = await getImageJob(runtimePool, jobId);
        return reply.code(200).send(buildPublicImageJobResponse(absoluteBase, appId, fresh!));
      }
      return reply.code(200).send({
        job_id: jobId,
        status: result.status,
        polling_url: `${absoluteBase}/v1/${appId}/images/completions/${jobId}`,
      });
    } catch (error) {
      return handleImageError(app, reply, organizationId, error);
    }
  });

  app.get('/v1/:appId/images/completions/:jobId/content', async (request, reply) => {
    const { appId, jobId } = request.params as { appId: string; jobId: string };

    const authz = await authorizeAppAiCall(app.controlDb, appId, request);
    if (!authz.ok) return reply.code(authz.status).send(authz.body);

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
      const job = await getImageJob(runtimePool, jobId);
      if (!job || job.app_id !== appId) return reply.code(404).send({ error: 'job_not_found', code: 'JOB_NOT_FOUND' });
      if (authz.caller.kind === 'end_user' && job.end_user_sub !== authz.caller.sub) {
        return reply.code(404).send({ error: 'job_not_found', code: 'JOB_NOT_FOUND' });
      }
      if (job.status !== 'completed') {
        return reply.code(409).send({ error: 'job_not_completed', code: 'JOB_NOT_COMPLETED', current_status: job.status });
      }

      const url = job.unsigned_urls?.[index];
      if (!url) return reply.code(404).send({ error: 'index_out_of_range', code: 'INDEX_OUT_OF_RANGE' });

      // Content is served adapter-agnostically: the row's unsigned_urls point at
      // provider-hosted CDN links (both OpenRouter and ImaRouter). Fetch through
      // rather than delegate to adapter.fetchImageContent so we don't need per-
      // adapter plumbing for what is a plain GET.
      const upstream = await fetch(url);
      if (!upstream.ok || !upstream.body) {
        return reply.code(502).send({ error: 'content_unavailable', code: 'CONTENT_UNAVAILABLE' });
      }
      return reply
        .code(200)
        .header('Content-Type', job.content_type ?? upstream.headers.get('content-type') ?? 'image/png')
        .send(Readable.fromWeb(upstream.body as any));
    } catch (error) {
      return handleImageError(app, reply, organizationId, error);
    }
  });
}

/**
 * Poll the upstream for an image job and, if terminal, settle the lease + mark
 * the row. Shared between the customer GET handler and any future sweeper.
 * Returns the upstream poll status and whether the row reached terminal here.
 */
export async function pollAndSettleImageJob(
  ctx: RouteContext,
  job: ImageJobRow,
): Promise<{ status: string; terminal: boolean }> {
  const poll = await routeImagePoll(ctx, job.upstream_router as RouterName, job.upstream_polling_url);

  if (poll.status === 'in_progress' && job.status === 'pending') {
    await markImageJobInProgress(ctx.runtimePool, job.id);
  }

  if (!['completed', 'failed', 'cancelled', 'expired'].includes(poll.status)) {
    return { status: poll.status, terminal: false };
  }

  // Settlement cost resolution:
  //   1) upstream's reported per-job cost (poll.providerCostUsd), or
  //   2) billedImageCostUsd — catalog fallback pinned to the chosen router.
  //   3) $0 as final guard — only `failed`/`cancelled` paths, where charging
  //      would be wrong anyway.
  let providerCost = poll.providerCostUsd ?? 0;
  if (poll.providerCostUsd === undefined && poll.status === 'completed') {
    const entry = await readCatalogEntry(ctx.redis, job.model);
    if (entry) {
      const billed = billedImageCostUsd(
        entry,
        job.request_json as unknown as import('../services/ai-router/adapters/types.js').ImageGenerationRequest,
        job.upstream_router as RouterName,
      );
      if (billed !== null) providerCost = billed;
    }
  }

  const terminal = await markImageJobTerminal(ctx.runtimePool, job.id, {
    status: poll.status as 'completed' | 'failed' | 'cancelled' | 'expired',
    unsignedUrls: poll.unsignedUrls,
    contentType: poll.contentType,
    providerCostUsd: providerCost,
    chargedCreditsUsd: applyMarkup(providerCost, parseFloat(job.markup_pct)),
    error: poll.error,
  });

  if (terminal.firstTerminal) {
    await settleImageJob(ctx, {
      leaseId: job.lease_id,
      chosenRouter: job.upstream_router as RouterName,
      canonicalModel: job.model,
      providerCostUsd: providerCost,
    });
  }
  return { status: poll.status, terminal: true };
}

export function buildPublicImageJobResponse(absoluteBase: string, appId: string, job: ImageJobRow) {
  const base = `${absoluteBase}/v1/${appId}/images/completions/${job.id}`;
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

/**
 * Per-model supported-param whitelist (option C from spec). Ask every adapter
 * which one owns this canonical, then validate the request body against its
 * whitelist. Returns null when accepted, or the 400 UNSUPPORTED_PARAM response
 * body when a top-level or provider key is not supported by the model.
 *
 * Extracted from the POST handler so it's unit-testable without a Fastify
 * instance. When no adapter claims the model (both return null), validation is
 * skipped and the request proceeds — the router will surface MODEL_NOT_FOUND
 * or WRONG_MODALITY from the catalog lookup.
 */
export function validateImageParams(
  body: z.infer<typeof imageSubmitSchema>,
  adapters: Map<RouterName, RouterAdapter>,
): Record<string, unknown> | null {
  let paramSpec: import('../services/ai-router/adapters/types.js').ImageSupportedParams | null = null;
  for (const adapter of adapters.values()) {
    const s = adapter.getSupportedImageParams?.(body.model);
    if (s) { paramSpec = s; break; }
  }
  if (!paramSpec) return null;

  const populatedTopLevel = ['size', 'aspect_ratio', 'n', 'seed', 'negative_prompt', 'input_images', 'mask']
    .filter(k => (body as Record<string, unknown>)[k] !== undefined);
  for (const k of populatedTopLevel) {
    if (!paramSpec.topLevel.has(k)) {
      return {
        error: `Parameter '${k}' is not supported by model ${body.model}`,
        code: 'UNSUPPORTED_PARAM',
        param: k,
        model: body.model,
        supported_top_level: [...paramSpec.topLevel],
        supported_provider: [...paramSpec.provider],
      };
    }
  }
  for (const k of Object.keys(body.provider ?? {})) {
    if (!paramSpec.provider.has(k)) {
      return {
        error: `Provider parameter '${k}' is not supported by model ${body.model}`,
        code: 'UNSUPPORTED_PARAM',
        param: `provider.${k}`,
        model: body.model,
        supported_provider: [...paramSpec.provider],
      };
    }
  }
  return null;
}

export async function handleImageError(app: FastifyInstance, reply: any, organizationId: string, error: unknown) {
  if (error instanceof InsufficientCreditsError) {
    const ar = await readAutoRefillState(app.controlDb, organizationId).catch(() => ({
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
    app.log.warn({ err: error, attempted: error.attempted, internalCode: error.code }, 'Image request failed');
    const publicCode = error.code === 'MODEL_NOT_FOUND' ? 'MODEL_NOT_FOUND'
      : error.code === 'WRONG_MODALITY' ? 'WRONG_MODALITY'
      : 'MODEL_UNAVAILABLE';
    return reply.code(error.statusCode).send({ error: error.message, code: publicCode });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: 'Invalid request', details: error.errors });
  }
  if (isHttpError(error)) throw error;
  app.log.error({ err: error }, 'Failed to process image request');
  return reply.code(500).send(apiError(error, 'Failed to process image request'));
}
