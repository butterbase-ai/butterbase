import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getRedisClient } from '../services/redis.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import {
  routeChatCompletion, routeEmbedding,
  RouterError, InsufficientCreditsError,
} from '../services/ai-router/router.js';
import { listCatalogModels, readCatalogEntry, readEnabledRouters } from '../services/ai-router/catalog.js';
import { rankRoutersForModel } from '../services/ai-router/select.js';
import { applyMarkup } from '../services/ai-router/markup.js';
import { openrouterAdapter } from '../services/ai-router/adapters/openrouter.js';
import type { RouterAdapter } from '../services/ai-router/adapters/types.js';
import { AdapterError } from '../services/ai-router/adapters/types.js';
import type { RouterName } from '../services/ai-router/normalize.js';

const GATEWAY_SCOPE = 'ai:gateway';

const contentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string(), detail: z.string().optional() }) }),
  z.object({ type: z.literal('video_url'), video_url: z.object({ url: z.string() }) }),
  z.object({ type: z.string() }).passthrough(),
]);

const chatCompletionSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(contentPartSchema)]),
  })),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().optional(),
  temperature: z.number().min(0).max(2).optional(),
}).passthrough();

const embeddingSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(z.string())]),
  encoding_format: z.enum(['float', 'base64']).optional(),
});

async function buildAdapters(): Promise<Map<RouterName, RouterAdapter>> {
  const m = new Map<RouterName, RouterAdapter>();
  if (config.aiRouter.openrouterApiKey) m.set('openrouter', openrouterAdapter({ apiKey: config.aiRouter.openrouterApiKey }));
  try {
    // @ts-expect-error — overlay path resolved at runtime
    const overlay = await import('../../../../cloud-overlays/dist/cloud-overlays/bootstrap.js');
    if (config.aiRouter.providerPrimaryApiKey) m.set('provider-primary', overlay.providerPrimaryAdapter({ apiKey: config.aiRouter.providerPrimaryApiKey }));
    if (config.aiRouter.providerSecondaryApiKey) m.set('provider-secondary', overlay.providerSecondaryAdapter({ apiKey: config.aiRouter.providerSecondaryApiKey }));
    if (config.aiRouter.providerTertiaryApiKey) m.set('provider-tertiary', overlay.providerTertiaryAdapter({ apiKey: config.aiRouter.providerTertiaryApiKey, baseUrl: config.aiRouter.providerTertiaryBaseUrl }));
  } catch { /* OSS mode: only openrouter is available */ }
  return m;
}

interface GatewayUser { userId: string; region: string; }

function resolveGatewayUser(request: FastifyRequest): GatewayUser {
  const { userId, authMethod, scopes } = request.auth;
  if (!userId) {
    const e = new Error('missing_credentials') as Error & { gatewayStatus: number; gatewayCode: string };
    e.gatewayStatus = 401;
    e.gatewayCode = 'missing_credentials';
    throw e;
  }
  if (authMethod === 'api_key') {
    const ok = scopes.includes('*') || scopes.includes(GATEWAY_SCOPE);
    if (!ok) {
      const e = new Error('insufficient_scope') as Error & { gatewayStatus: number; gatewayCode: string };
      e.gatewayStatus = 403;
      e.gatewayCode = 'insufficient_scope';
      throw e;
    }
  }
  return { userId, region: config.aiRouter.defaultRegion };
}

function openaiError(message: string, type: string, code: string, extra?: Record<string, unknown>) {
  return { error: { message, type, code, ...(extra ?? {}) } };
}

async function handleRouterError(reply: FastifyReply, err: unknown): Promise<FastifyReply> {
  if ((err as { gatewayStatus?: number }).gatewayStatus) {
    const e = err as { gatewayStatus: number; gatewayCode: string };
    const type = e.gatewayStatus === 401
      ? 'authentication_error'
      : e.gatewayStatus === 403 ? 'permission_error' : 'api_error';
    return reply.code(e.gatewayStatus).send(openaiError(e.gatewayCode, type, e.gatewayCode));
  }
  if (err instanceof InsufficientCreditsError) {
    return reply.code(402).send(openaiError(
      err.message, 'billing_error', 'insufficient_credits',
      { required_usd: err.requiredUsd, available_usd: err.availableUsd },
    ));
  }
  if (err instanceof RouterError) {
    // Public code never mentions "router" — we don't disclose that this is a
    // fan-out gateway. Internal code + attempted chain go to logs only.
    const ROUTER_CODE_MAP: Record<RouterError['code'], string> = {
      MODEL_NOT_FOUND: 'model_not_found',
      NO_ROUTERS_AVAILABLE: 'model_unavailable',
      ROUTER_FALLBACK_EXHAUSTED: 'model_unavailable',
      WRONG_MODALITY: 'wrong_modality',
    };
    const type = (err.code === 'MODEL_NOT_FOUND' || err.code === 'WRONG_MODALITY') ? 'invalid_request_error' : 'api_error';
    return reply.code(err.statusCode).send(openaiError(
      err.message, type, ROUTER_CODE_MAP[err.code],
    ));
  }
  if (err instanceof AdapterError) {
    // AdapterError.kind ('transport', 'rate_limit', etc.) is generic enough to
    // share, but never include the adapter name (err.router) which would leak
    // upstream provider identity.
    return reply.code(err.statusCode).send(openaiError(
      err.message,
      'invalid_request_error',
      err.kind,
    ));
  }
  if (err instanceof z.ZodError) {
    return reply.code(400).send(openaiError(
      'Invalid request body', 'invalid_request_error', 'invalid_request',
      { details: err.errors },
    ));
  }
  return reply.code(500).send(openaiError('Internal error', 'api_error', 'internal_error'));
}

export async function gatewayRoutes(app: FastifyInstance) {
  const adapters = await buildAdapters();

  // Fix 3: Rewrite Butterbase-shaped 401 errors on /v1/* paths to OpenAI shape.
  // The auth plugin fires in onRequest before the route handler, so gateway error
  // handling never runs for rejected keys. This onSend hook intercepts the reply.
  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.url.startsWith('/v1/')) return payload;
    if (reply.statusCode !== 401) return payload;
    if (typeof payload !== 'string') return payload;
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { return payload; }
    const p = parsed as { error?: { type?: string; code?: string; message?: string } };
    if (p.error?.type) return payload; // already OpenAI shape
    return JSON.stringify({
      error: {
        message: p.error?.message ?? 'Invalid API key',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    });
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    try {
      const user = resolveGatewayUser(request);
      const body = chatCompletionSchema.parse(request.body);
      const runtimePool = getRuntimeDbPool(config.runtimeDb, user.region);
      const result = await routeChatCompletion(
        {
          platformPool: app.controlDb,
          runtimePool,
          redis: getRedisClient(),
          adapters,
          markupPct: config.aiRouter.markupPct,
          appId: null,
          userId: user.userId,
          region: user.region,
        },
        body,
      );
      if (result.stream) {
        reply.raw.writeHead(result.status, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        const reader = result.stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          reply.raw.write(value);
        }
        reply.raw.end();
        return;
      }
      return reply.code(result.status).send(result.body);
    } catch (err) {
      return handleRouterError(reply, err);
    }
  });

  app.post('/v1/embeddings', async (request, reply) => {
    try {
      const user = resolveGatewayUser(request);
      const body = embeddingSchema.parse(request.body);
      const runtimePool = getRuntimeDbPool(config.runtimeDb, user.region);
      const result = await routeEmbedding(
        {
          platformPool: app.controlDb,
          runtimePool,
          redis: getRedisClient(),
          adapters,
          markupPct: config.aiRouter.markupPct,
          appId: null,
          userId: user.userId,
          region: user.region,
        },
        body,
      );
      return reply.code(result.status).send(result.body);
    } catch (err) {
      return handleRouterError(reply, err);
    }
  });

  app.get('/v1/models', async (request, reply) => {
    try {
      resolveGatewayUser(request);
      const ids = await listCatalogModels(getRedisClient());
      const data = await Promise.all(
        ids.map(async (id) => {
          const entry = await readCatalogEntry(getRedisClient(), id);
          return entry
            ? { id: entry.canonicalId, object: 'model', display_name: entry.displayName }
            : null;
        }),
      );
      return reply.send({ object: 'list', data: data.filter(Boolean) });
    } catch (err) {
      return handleRouterError(reply, err);
    }
  });

  // Public catalog — no auth required. Returns rich model metadata for
  // browsing UIs (display name, representative router + prices, context).
  app.get('/v1/public/models', { config: { public: true } }, async (_request, reply) => {
    try {
      const redis = getRedisClient();
      const [ids, enabled] = await Promise.all([
        listCatalogModels(redis),
        readEnabledRouters(redis),
      ]);
      const enabledSet = new Set(enabled.filter(r => r.enabled).map(r => r.name));
      const entries = await Promise.all(ids.map(id => readCatalogEntry(redis, id)));
      const markupPct = config.aiRouter.markupPct;
      const models = entries.filter((e): e is NonNullable<typeof e> => Boolean(e)).map((e) => {
        const ranked = rankRoutersForModel(e, enabledSet);
        const best = ranked[0] ?? e.routers[0];
        return {
          id: e.canonicalId,
          name: e.displayName,
          inputPricePerMTokens: best ? applyMarkup(best.promptPricePerMtok, markupPct) : undefined,
          outputPricePerMTokens: best ? applyMarkup(best.completionPricePerMtok, markupPct) : undefined,
          contextWindow: best?.contextLength ?? null,
        };
      });
      return reply.send({ models });
    } catch (err) {
      return handleRouterError(reply, err);
    }
  });
}
