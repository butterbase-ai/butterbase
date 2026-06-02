// services/control-api/src/routes/ai-config.ts
import { Readable } from 'node:stream';
import { apiError } from '../utils/api-error.js';
import { isHttpError } from '../services/error-handler.js';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { proxyChatCompletion, proxyEmbedding, getAvailableModels, OpenRouterError } from '../services/openrouter-gateway.js';
import { getAiUsageSummary } from '../services/ai-usage-logger.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { requireUserId } from '../utils/require-auth.js';
import { authorizeAppAiCall } from '../services/ai-router/authorize-app-call.js';
import { logFromRequest } from '../services/audit/with-audit.js';
import { config } from '../config.js';
import {
  chatCompletionRequestSchema as chatCompletionSchema,
  embeddingRequestSchema,
} from '../services/ai-router/schemas.js';
import { resolveAppHomeRegion, getRuntimeDbForApp } from '../services/region-resolver.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { getRedisClient } from '../services/redis.js';
import { routeChatCompletion, routeEmbedding, RouterError, InsufficientCreditsError } from '../services/ai-router/router.js';
import { openrouterAdapter } from '../services/ai-router/adapters/openrouter.js';
import { listCatalogModels, readCatalogEntry } from '../services/ai-router/catalog.js';
import type { RouterAdapter } from '../services/ai-router/adapters/types.js';
import type { RouterName } from '../services/ai-router/normalize.js';

export async function readAutoRefillState(controlPool: pg.Pool, userId: string): Promise<{
  enabled: boolean;
  amountUsd: number | null;
  monthlyAllowanceUsd: number;
  topupUsd: number;
}> {
  const r = await controlPool.query<{
    auto_refill_enabled: boolean;
    auto_refill_amount_usd: string | null;
    monthly_allowance_usd: string;
    credits_usd: string;
  }>(
    `SELECT auto_refill_enabled, auto_refill_amount_usd, monthly_allowance_usd, credits_usd
     FROM platform_users WHERE id = $1`,
    [userId]
  );
  if (r.rows.length === 0) {
    return { enabled: false, amountUsd: null, monthlyAllowanceUsd: 0, topupUsd: 0 };
  }
  const row = r.rows[0];
  return {
    enabled: row.auto_refill_enabled,
    amountUsd: row.auto_refill_amount_usd != null ? parseFloat(row.auto_refill_amount_usd) : null,
    monthlyAllowanceUsd: parseFloat(row.monthly_allowance_usd),
    topupUsd: parseFloat(row.credits_usd),
  };
}

async function getAppDefaultModel(runtimePool: pg.Pool, appId: string): Promise<string | null> {
  const r = await runtimePool.query<{ ai_config: { defaultModel?: string } | null }>(
    `SELECT ai_config FROM apps WHERE id = $1`,
    [appId]
  );
  if (r.rows.length === 0) return null;
  return r.rows[0].ai_config?.defaultModel ?? null;
}

async function buildAdapters(): Promise<Map<RouterName, RouterAdapter>> {
  const m = new Map<RouterName, RouterAdapter>();
  if (config.aiRouter.openrouterApiKey) m.set('openrouter', openrouterAdapter({ apiKey: config.aiRouter.openrouterApiKey }));
  try {
    // @ts-expect-error — overlay path resolved at runtime
    const overlay = await import('../../../../cloud-overlays/dist/cloud-overlays/bootstrap.js');
    if (config.aiRouter.providerPrimaryApiKey) m.set('provider-primary', overlay.providerPrimaryAdapter({
      apiKey: config.aiRouter.providerPrimaryApiKey,
      baseUrl: config.aiRouter.providerPrimaryBaseUrl,
    }));
    if (config.aiRouter.providerSecondaryApiKey) m.set('provider-secondary', overlay.providerSecondaryAdapter({
      apiKey: config.aiRouter.providerSecondaryApiKey,
      baseUrl: config.aiRouter.providerSecondaryBaseUrl,
      catalogUrl: config.aiRouter.providerSecondaryCatalogUrl,
    }));
    if (config.aiRouter.providerTertiaryApiKey) m.set('provider-tertiary', overlay.providerTertiaryAdapter({
      apiKey: config.aiRouter.providerTertiaryApiKey,
      baseUrl: config.aiRouter.providerTertiaryBaseUrl,
    }));
  } catch { /* OSS mode: only openrouter is available */ }
  return m;
}

const aiConfigSchema = z.object({
  defaultModel: z.string().optional(),
  byokKey: z.string().optional(),
  maxTokensPerRequest: z.number().int().min(1).max(100000).optional(),
  allowedModels: z.array(z.string()).optional(),
});

// App-scoped embedding schema: makes model optional since it can be resolved
// from app config or platform defaults (unlike the gateway which requires it).
const embeddingSchema = embeddingRequestSchema.extend({
  model: z.string().optional(),
});

export async function aiConfigRoutes(app: FastifyInstance) {
  const adapters = await buildAdapters();

  // Get AI configuration
  app.get('/v1/:appId/ai/config', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);

    try {
      // Verify ownership
      const region = await resolveAppHomeRegion(app.controlDb, appId);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      const ownerResult = await runtimeDb.query(
        'SELECT owner_id, ai_config FROM apps WHERE id = $1',
        [appId]
      );

      if (ownerResult.rows.length === 0) {
        return reply.code(404).send({ error: 'App not found' });
      }

      if (ownerResult.rows[0].owner_id !== userId) {
        return reply.code(403).send({ error: 'Not authorized' });
      }

      const aiConfig = ownerResult.rows[0].ai_config || {};

      // Decrypt and mask BYOK key if present
      if (aiConfig.byokKey) {
        try {
          // Check if it's encrypted (format: iv:ciphertext:authTag)
          if (aiConfig.byokKey.includes(':')) {
            const encryptionKey = process.env.AUTH_ENCRYPTION_KEY;
            if (!encryptionKey) {
              app.log.error('AUTH_ENCRYPTION_KEY not set, cannot decrypt BYOK key');
              aiConfig.byokKey = '***encrypted';
            } else {
              const decrypted = decrypt(aiConfig.byokKey, encryptionKey);
              aiConfig.byokKey = '***' + decrypted.slice(-4);
            }
          } else {
            // Legacy unencrypted key - just mask it
            aiConfig.byokKey = '***' + aiConfig.byokKey.slice(-4);
          }
        } catch (error) {
          if (isHttpError(error)) throw error;
          app.log.error({ err: error }, 'Failed to decrypt BYOK key');
          aiConfig.byokKey = '***error';
        }
      }

      return { config: aiConfig };
    } catch (error) {
      if (isHttpError(error)) throw error;
      app.log.error({ err: error }, 'Failed to get AI config');
      return reply.code(500).send(apiError(error, 'Failed to get AI configuration'));
    }
  });

  // Update AI configuration
  app.put('/v1/:appId/ai/config', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);

    try {
      // Verify ownership
      const region = await resolveAppHomeRegion(app.controlDb, appId);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      const ownerResult = await runtimeDb.query(
        'SELECT owner_id, ai_config FROM apps WHERE id = $1',
        [appId]
      );

      if (ownerResult.rows.length === 0) {
        return reply.code(404).send({ error: 'App not found' });
      }

      if (ownerResult.rows[0].owner_id !== userId) {
        return reply.code(403).send({ error: 'Not authorized' });
      }

      const body = aiConfigSchema.parse(request.body);
      const currentConfig = ownerResult.rows[0].ai_config || {};

      // Encrypt BYOK key if provided
      if (body.byokKey) {
        const encryptionKey = process.env.AUTH_ENCRYPTION_KEY;
        if (!encryptionKey) {
          return reply.code(500).send({ error: 'Server encryption not configured' });
        }
        body.byokKey = encrypt(body.byokKey, encryptionKey);
      }

      // Merge with existing config
      const newConfig = {
        ...currentConfig,
        ...body,
      };

      // Update in database
      await runtimeDb.query(
        'UPDATE apps SET ai_config = $1, updated_at = now() WHERE id = $2',
        [JSON.stringify(newConfig), appId]
      );

      logFromRequest(request, {
        appId,
        category: 'admin',
        eventType: 'ai.config.update',
        action: 'update',
        resourceType: 'ai_config',
        eventData: {
          changed_fields: Object.keys(body),
          defaultModel: newConfig.defaultModel,
          allowedModels: newConfig.allowedModels,
        },
        success: true,
      });

      return { config: newConfig };
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request', details: error.errors });
      }
      app.log.error({ err: error }, 'Failed to update AI config');
      return reply.code(500).send(apiError(error, 'Failed to update AI configuration'));
    }
  });

  // Chat completions endpoint (OpenAI-compatible)
  app.post('/v1/:appId/chat/completions', async (request, reply) => {
    const { appId } = request.params as { appId: string };

    // Authorize the caller (owner JWT/key, end-user JWT for this app, or
    // app-scoped API key) and resolve the billing identity. See
    // authorize-app-call.ts for the full policy.
    const authz = await authorizeAppAiCall(app.controlDb, appId, request);
    if (!authz.ok) return reply.code(authz.status).send(authz.body);
    const ownerId = authz.ownerId;

    try {
      const body = chatCompletionSchema.parse(request.body);

      // ---- v2 path: multi-router gateway ----
      if (config.aiRouter.enabled) {
        const region = await resolveAppHomeRegion(app.controlDb, appId);
        const runtimePool = await getRuntimeDbForApp(app.controlDb, appId);

        const modelResolved = body.model
          || (await getAppDefaultModel(runtimePool, appId))
          || config.aiRouter.platformDefaultModel;

        if (!modelResolved) {
          return reply.code(400).send({
            error: 'no_model',
            code: 'NO_MODEL',
            message: 'No model specified and no default configured. Set apps.ai_config.defaultModel or pass a model in the request.',
          });
        }

        const catalogEntry = await readCatalogEntry(getRedisClient(), modelResolved);
        if (catalogEntry && catalogEntry.routers.length > 0 && catalogEntry.routers.every(r => r.modality === 'video')) {
          return reply.code(400).send({
            error: 'wrong_endpoint',
            code: 'USE_VIDEO_ENDPOINT',
            message: `Model ${modelResolved} is a video model. Use POST /v1/${appId}/videos/completions instead.`,
          });
        }

        const result = await routeChatCompletion(
          {
            platformPool: app.controlDb,
            runtimePool,
            redis: getRedisClient(),
            adapters,
            markupPct: config.aiRouter.markupPct,
            appId, userId: ownerId, region,
          },
          { ...body, model: modelResolved }
        );

        if (result.stream) {
          // Use reply.send with a Node Readable so Fastify's onSend hooks
          // (notably @fastify/cors) inject response headers. Writing via
          // reply.raw bypasses the lifecycle and drops CORS headers.
          return reply
            .code(result.status)
            .header('Content-Type', 'text/event-stream')
            .header('Cache-Control', 'no-cache')
            .header('Connection', 'keep-alive')
            .send(Readable.fromWeb(result.stream as any));
        }
        return reply.code(result.status).send(result.body);
      }

      // ---- legacy v1 path (unchanged) ----
      // FIXME(batch-9.7): proxyChatCompletion takes Pool and queries apps/ai_usage_logs (runtime) — migrate service signature
      const response = await proxyChatCompletion(
        app.controlDb,
        appId,
        ownerId,
        body as Parameters<typeof proxyChatCompletion>[3]
      );

      // Stream the response via Fastify so onSend hooks (CORS) still run.
      if (body.stream) {
        if (!response.body) {
          return reply.code(response.status).send();
        }
        return reply
          .code(response.status)
          .header('Content-Type', 'text/event-stream')
          .header('Cache-Control', 'no-cache')
          .header('Connection', 'keep-alive')
          .send(Readable.fromWeb(response.body as any));
      } else {
        const data = await response.json();
        return reply.send(data);
      }
    } catch (error) {
      // Typed errors carry their own statusCode and must be handled before the
      // generic isHttpError rethrow — RouterError/InsufficientCreditsError/
      // OpenRouterError all satisfy isHttpError and would otherwise escape to
      // the global handler which masks them as a generic 500.
      if (error instanceof InsufficientCreditsError) {
        const ar = await readAutoRefillState(app.controlDb, ownerId).catch(() => ({
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
        // Internal-only: full attempted chain + original code go to logs/Sentry.
        // Public response uses a generic code/message so we don't reveal which
        // upstream providers we use or that we run a fan-out router.
        app.log.warn({ err: error, attempted: error.attempted, internalCode: error.code }, 'Model request failed');
        const publicCode = error.code === 'MODEL_NOT_FOUND' ? 'MODEL_NOT_FOUND' : 'MODEL_UNAVAILABLE';
        return reply.code(error.statusCode).send({
          error: error.message,
          code: publicCode,
        });
      }
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request', details: error.errors });
      }
      if (error instanceof OpenRouterError) {
        return reply.code(error.statusCode).send({ error: error.message, code: error.code });
      }
      if (isHttpError(error)) throw error;
      app.log.error({ err: error }, 'Failed to process chat completion');
      return reply.code(500).send(apiError(error, 'Failed to process chat completion'));
    }
  });

  // Embeddings endpoint (OpenAI-compatible)
  app.post('/v1/:appId/embeddings', async (request, reply) => {
    const { appId } = request.params as { appId: string };

    const authz = await authorizeAppAiCall(app.controlDb, appId, request);
    if (!authz.ok) return reply.code(authz.status).send(authz.body);
    const ownerId = authz.ownerId;

    try {
      const body = embeddingSchema.parse(request.body);

      // ---- v2 path: multi-router gateway ----
      if (config.aiRouter.enabled) {
        const region = await resolveAppHomeRegion(app.controlDb, appId);
        const runtimePool = await getRuntimeDbForApp(app.controlDb, appId);

        const modelResolved = body.model
          || (await getAppDefaultModel(runtimePool, appId))
          || config.aiRouter.platformDefaultModel;

        if (!modelResolved) {
          return reply.code(400).send({
            error: 'no_model',
            code: 'NO_MODEL',
            message: 'No model specified and no default configured. Set apps.ai_config.defaultModel or pass a model in the request.',
          });
        }

        const result = await routeEmbedding(
          {
            platformPool: app.controlDb,
            runtimePool,
            redis: getRedisClient(),
            adapters,
            markupPct: config.aiRouter.markupPct,
            appId, userId: ownerId, region,
          },
          { ...body, model: modelResolved }
        );
        return reply.code(result.status).send(result.body);
      }

      // ---- legacy v1 path (unchanged) ----
      // FIXME(batch-9.7): proxyEmbedding takes Pool and queries apps/ai_usage_logs (runtime) — migrate service signature
      const response = await proxyEmbedding(
        app.controlDb,
        appId,
        ownerId,
        body as Parameters<typeof proxyEmbedding>[3]
      );

      const data = await response.json();
      return reply.code(response.status).send(data);
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        const ar = await readAutoRefillState(app.controlDb, ownerId).catch(() => ({
          enabled: false, amountUsd: null, monthlyAllowanceUsd: 0, topupUsd: 0,
        }));
        return reply.code(402).send({
          error: 'insufficient_credits', code: 'INSUFFICIENT_CREDITS',
          required_usd: error.requiredUsd, available_usd: error.availableUsd,
          monthly_allowance_usd: ar.monthlyAllowanceUsd,
          credits_usd: ar.topupUsd,
          auto_refill_enabled: ar.enabled,
          auto_refill_amount_usd: ar.amountUsd,
        });
      }
      if (error instanceof RouterError) {
        app.log.warn({ err: error, attempted: error.attempted, internalCode: error.code }, 'Model request failed');
        const publicCode = error.code === 'MODEL_NOT_FOUND' ? 'MODEL_NOT_FOUND' : 'MODEL_UNAVAILABLE';
        return reply.code(error.statusCode).send({
          error: error.message, code: publicCode,
        });
      }
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request', details: error.errors });
      }
      if (error instanceof OpenRouterError) {
        return reply.code(error.statusCode).send({ error: error.message, code: error.code });
      }
      if (isHttpError(error)) throw error;
      app.log.error({ err: error }, 'Failed to process embedding request');
      return reply.code(500).send(apiError(error, 'Failed to process embedding request'));
    }
  });

  // List available AI models
  app.get('/v1/:appId/ai/models', async (request, reply) => {
    try {
      // ---- v2 path: multi-router catalog ----
      if (config.aiRouter.enabled) {
        const redis = getRedisClient();
        const ids = await listCatalogModels(redis);
        const entries = await Promise.all(ids.map(id => readCatalogEntry(redis, id)));
        const models = entries.filter(Boolean).map(e => {
          const firstRouter = e!.routers.length > 0 ? e!.routers[0] : null;
          // Derive modality: pick the first router's modality if set, otherwise default to 'chat'
          const modality = firstRouter?.modality ?? 'chat';
          // For token-priced modalities (chat, embedding), expose token pricing
          const isTokenPriced = modality === 'chat' || modality === 'embedding';
          return {
            id: e!.canonicalId,
            name: e!.displayName,
            context_length: e!.routers.length > 0 ? Math.max(...e!.routers.map(r => r.contextLength)) : 0,
            modality,
            prompt_price_per_mtok: isTokenPriced && firstRouter ? firstRouter.promptPricePerMtok : null,
            completion_price_per_mtok: isTokenPriced && firstRouter ? firstRouter.completionPricePerMtok : null,
            raw_pricing: !isTokenPriced && firstRouter ? firstRouter.rawPricing ?? null : null,
          };
        });
        return { models };
      }

      // ---- legacy v1 path (unchanged) ----
      const models = await getAvailableModels();
      return { models };
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof OpenRouterError) {
        return reply.code(error.statusCode).send({ error: error.message, code: error.code });
      }
      app.log.error({ err: error }, 'Failed to fetch models');
      return reply.code(500).send(apiError(error, 'Failed to fetch available models'));
    }
  });

  // Get AI usage summary
  app.get('/v1/:appId/ai/usage', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);
    const { startDate, endDate } = request.query as { startDate?: string; endDate?: string };

    try {
      // Verify ownership
      const region = await resolveAppHomeRegion(app.controlDb, appId);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      const ownerResult = await runtimeDb.query(
        'SELECT owner_id FROM apps WHERE id = $1',
        [appId]
      );

      if (ownerResult.rows.length === 0) {
        return reply.code(404).send({ error: 'App not found' });
      }

      if (ownerResult.rows[0].owner_id !== userId) {
        return reply.code(403).send({ error: 'Not authorized' });
      }

      // FIXME(batch-9.7): getAiUsageSummary takes a Pool and queries ai_usage_logs (runtime) — migrate service signature
      const summary = await getAiUsageSummary(app.controlDb, appId, startDate, endDate);

      return summary;
    } catch (error) {
      if (isHttpError(error)) throw error;
      app.log.error({ err: error }, 'Failed to get AI usage');
      return reply.code(500).send(apiError(error, 'Failed to get AI usage'));
    }
  });
}
