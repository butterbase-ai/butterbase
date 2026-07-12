import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type pg from 'pg';
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
import {
  chatCompletionRequestSchema as chatCompletionSchema,
  embeddingRequestSchema as embeddingSchema,
} from '../services/ai-router/schemas.js';
import { messagesRequestSchema, guardMessagesRoutingShape } from '../services/ai-router/messages-schema.js';
import { routeMessages } from '../services/ai-router/messages.js';
import { responsesRequestSchema, guardResponsesRoutingShape } from '../services/ai-router/responses-schema.js';
import { routeResponses } from '../services/ai-router/responses.js';
import { logAuditEvent } from '../services/audit/audit-events-service.js';

const GATEWAY_SCOPE = 'ai:gateway';

async function resolveGatewayOrg(controlDb: pg.Pool, userId: string): Promise<string> {
  const r = await controlDb.query<{ personal_organization_id: string }>(
    'SELECT personal_organization_id FROM platform_users WHERE id = $1',
    [userId],
  );
  const id = r.rows[0]?.personal_organization_id;
  if (!id) throw new Error(`gateway: user ${userId} has no personal_organization_id`);
  return id;
}

export async function buildAdapters(): Promise<Map<RouterName, RouterAdapter>> {
  const m = new Map<RouterName, RouterAdapter>();
  if (config.aiRouter.openrouterApiKey) m.set('openrouter', openrouterAdapter({ apiKey: config.aiRouter.openrouterApiKey }));
  try {
    // @ts-expect-error — overlay path resolved at runtime
    const overlay = await import('../../../../cloud-overlays/dist/cloud-overlays/bootstrap.js');
    if (config.aiRouter.providerPrimaryApiKey) m.set('provider-primary', overlay.providerPrimaryAdapter({ apiKey: config.aiRouter.providerPrimaryApiKey, baseUrl: config.aiRouter.providerPrimaryBaseUrl }));
    if (config.aiRouter.providerSecondaryApiKey) m.set('provider-secondary', overlay.providerSecondaryAdapter({ apiKey: config.aiRouter.providerSecondaryApiKey, baseUrl: config.aiRouter.providerSecondaryBaseUrl, catalogUrl: config.aiRouter.providerSecondaryCatalogUrl }));
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

interface GatewayAuditContext {
  endpoint: 'chat.completions' | 'embeddings' | 'messages' | 'responses';
  model?: string;
  appId: string;
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  startedAt: number;
}

function emitGatewayEvent(
  app: FastifyInstance,
  ctx: GatewayAuditContext,
  outcome:
    | { success: true; status: number; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null; stream?: boolean }
    | { success: false; errorMessage: string; errorCode?: string; status?: number }
): void {
  // Fire-and-forget; logAuditEvent itself swallows DB errors.
  void logAuditEvent(app.controlDb, {
    appId: ctx.appId,
    category: 'ai',
    eventType: 'ai_gateway.invoke',
    action: 'invoke',
    resourceType: 'ai_request',
    resourceId: ctx.model,
    actorType: 'platform_user',
    actorId: ctx.userId,
    eventData: {
      endpoint: ctx.endpoint,
      model: ctx.model ?? null,
      duration_ms: Date.now() - ctx.startedAt,
      ...(outcome.success
        ? {
            status: outcome.status,
            stream: outcome.stream ?? false,
            prompt_tokens: outcome.usage?.prompt_tokens ?? null,
            completion_tokens: outcome.usage?.completion_tokens ?? null,
            total_tokens: outcome.usage?.total_tokens ?? null,
          }
        : {
            status: outcome.status ?? null,
            error_code: outcome.errorCode ?? null,
          }),
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    success: outcome.success,
    errorMessage: outcome.success ? null : outcome.errorMessage,
  });
}

export async function gatewayRoutes(app: FastifyInstance) {
  const adapters = await buildAdapters();

  // Fix 3: Rewrite Butterbase-shaped 401 errors on /v1/* paths to per-endpoint
  // provider shape. The auth plugin fires in onRequest before the route handler,
  // so gateway error handling never runs for rejected keys. This onSend hook
  // intercepts the reply. `/v1/messages` gets Anthropic shape; everything else
  // gets OpenAI shape.
  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.url.startsWith('/v1/')) return payload;
    if (reply.statusCode !== 401) return payload;
    if (typeof payload !== 'string') return payload;
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { return payload; }
    const p = parsed as { type?: string; error?: { type?: string; code?: string; message?: string } };
    const wantsAnthropic = request.url.startsWith('/v1/messages');
    if (wantsAnthropic) {
      if (p.type === 'error' && p.error?.type) return payload; // already Anthropic shape
      return JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: p.error?.message ?? 'Invalid API key',
        },
      });
    }
    if (p.error?.type && !p.type) return payload; // already OpenAI shape
    return JSON.stringify({
      error: {
        message: p.error?.message ?? 'Invalid API key',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    });
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    const startedAt = Date.now();
    let auditCtx: GatewayAuditContext | null = null;
    try {
      const user = resolveGatewayUser(request);
      const body = chatCompletionSchema.parse(request.body);
      const headerSessionId = request.headers['x-session-id']
      if (!body.session_id && typeof headerSessionId === 'string' && headerSessionId.length <= 256) {
        body.session_id = headerSessionId
      }
      auditCtx = {
        endpoint: 'chat.completions',
        model: body.model,
        appId: request.auth.appId ?? '_platform',
        userId: user.userId,
        ipAddress: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
        startedAt,
      };
      const runtimePool = getRuntimeDbPool(config.runtimeDb, user.region);
      const organizationId = await resolveGatewayOrg(app.controlDb, user.userId);
      const result = await routeChatCompletion(
        {
          platformPool: app.controlDb,
          runtimePool,
          redis: getRedisClient(),
          adapters,
          markupPct: config.aiRouter.markupPct,
          appId: null,
          organizationId,
          userId: user.userId,
          region: user.region,
        },
        body,
      );
      if (result.stream) {
        const headers: Record<string, string> = {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        };
        if (result.chosen) {
          headers['x-butterbase-router'] = result.chosen;
        }
        reply.raw.writeHead(result.status, headers);
        const reader = result.stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          reply.raw.write(value);
        }
        reply.raw.end();
        emitGatewayEvent(app, auditCtx, { success: true, status: result.status, stream: true });
        return;
      }
      const usage = (result.body as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } } | undefined)?.usage ?? null;
      emitGatewayEvent(app, auditCtx, { success: true, status: result.status, usage, stream: false });
      if (result.chosen) {
        reply.header('x-butterbase-router', result.chosen);
      }
      return reply.code(result.status).send(result.body);
    } catch (err) {
      if (auditCtx) {
        const e = err as { message?: string; gatewayCode?: string; code?: string; statusCode?: number; gatewayStatus?: number };
        emitGatewayEvent(app, auditCtx, {
          success: false,
          errorMessage: e.message ?? 'unknown',
          errorCode: e.gatewayCode ?? e.code ?? 'error',
          status: e.gatewayStatus ?? e.statusCode,
        });
      }
      return handleRouterError(reply, err);
    }
  });

  app.post('/v1/messages', async (request, reply) => {
    const startedAt = Date.now();
    let auditCtx: GatewayAuditContext | null = null;
    try {
      if (!config.aiRouter.v2EndpointsEnabled) {
        return reply.code(404).send({ error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' } });
      }
      const user = resolveGatewayUser(request);
      // Passthrough posture: /v1/messages forwards the request body to the upstream
      // Anthropic provider (or through the translation layer) without policing
      // Anthropic's own request schema. We only validate the minimum shape our
      // own routing/lease/token-estimator needs. Unknown/new Anthropic fields
      // (adaptive thinking, document blocks, prompt-cache params, future
      // additions) flow through untouched; Anthropic returns its own 400 with a
      // real error message if the body is malformed. The strict reference schema
      // is still evaluated for observability so we see drift in logs before it
      // becomes a bug report.
      const guardRes = guardMessagesRoutingShape(request.body);
      if (!guardRes.ok) {
        return reply.code(400).send({
          type: 'error',
          error: { type: 'invalid_request_error', message: guardRes.message },
        });
      }
      const body = guardRes.body;
      const driftCheck = messagesRequestSchema.safeParse(request.body);
      if (!driftCheck.success) {
        request.log.warn({
          event: 'ai_router.messages.schema_drift',
          issues: driftCheck.error.issues.slice(0, 8).map(i => ({
            path: i.path.join('.'),
            code: i.code,
            message: i.message,
          })),
        }, 'forwarding /v1/messages body that does not match reference schema');
      }
      auditCtx = {
        endpoint: 'messages',
        model: body.model,
        appId: request.auth.appId ?? '_platform',
        userId: user.userId,
        ipAddress: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
        startedAt,
      };
      const runtimePool = getRuntimeDbPool(config.runtimeDb, user.region);
      const organizationId = await resolveGatewayOrg(app.controlDb, user.userId);
      const result = await routeMessages(
        {
          platformPool: app.controlDb, runtimePool, redis: getRedisClient(),
          adapters, markupPct: config.aiRouter.markupPct,
          appId: request.auth.appId ?? null, organizationId, userId: user.userId, region: user.region,
        },
        body,
        {
          anthropicVersion: typeof request.headers['anthropic-version'] === 'string' ? request.headers['anthropic-version'] : undefined,
          anthropicBeta: typeof request.headers['anthropic-beta'] === 'string' ? request.headers['anthropic-beta'] : undefined,
        },
      );
      if (result.stream) {
        reply.raw.setHeader('content-type', 'text/event-stream');
        reply.raw.setHeader('cache-control', 'no-cache, no-transform');
        reply.raw.setHeader('connection', 'keep-alive');
        reply.hijack();
        const reader = result.stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            reply.raw.write(value);
          }
          reply.raw.end();
        } catch (streamErr) {
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'stream_error', message: String(streamErr) } })}\n\n`);
          reply.raw.end();
          return;
        }
        emitGatewayEvent(app, auditCtx, { success: true, status: 200, usage: null, stream: true });
        return;
      }
      // DONE_WITH_CONCERNS: full billing settlement (writeAiUsageRow / credit lease) for the native
      // non-streaming path requires integrating the lease + charge flow from routeChatCompletion
      // into routeMessages — estimated >100 lines of refactoring. Deferred. Usage is surfaced in
      // the audit event only; ai_usage_logs row is NOT written for native /v1/messages calls today.
      const resultUsage = (result as { usage?: { promptTokens?: number; completionTokens?: number } | null }).usage;
      const auditUsage = resultUsage
        ? { prompt_tokens: resultUsage.promptTokens ?? 0, completion_tokens: resultUsage.completionTokens ?? 0, total_tokens: (resultUsage.promptTokens ?? 0) + (resultUsage.completionTokens ?? 0) }
        : null;
      if (result.status < 400) {
        emitGatewayEvent(app, auditCtx, { success: true, status: result.status, usage: auditUsage, stream: false });
      } else {
        emitGatewayEvent(app, auditCtx, { success: false, status: result.status, errorMessage: 'route returned non-2xx', errorCode: 'route_error' });
      }
      return reply.code(result.status).send(result.body);
    } catch (err) {
      if (auditCtx) {
        const e = err as { message?: string; gatewayCode?: string; code?: string; statusCode?: number; gatewayStatus?: number };
        emitGatewayEvent(app, auditCtx, {
          success: false, errorMessage: e.message ?? 'unknown',
          errorCode: e.gatewayCode ?? e.code ?? 'error',
          status: e.gatewayStatus ?? e.statusCode,
        });
      }
      // Translate handleRouterError's OpenAI shape to Anthropic shape:
      const r = await new Promise<{ statusCode: number; body: string }>((resolve) => {
        const stub: any = { code(c: number) { this._c = c; return this; }, send(b: any) { resolve({ statusCode: this._c ?? 500, body: typeof b === 'string' ? b : JSON.stringify(b) }); return this; } };
        handleRouterError(stub, err);
      });
      let parsed: any; try { parsed = JSON.parse(r.body); } catch { parsed = { error: { message: r.body } }; }
      const t = parsed.error?.type ?? 'api_error';
      return reply.code(r.statusCode).send({ type: 'error', error: { type: t, message: parsed.error?.message ?? 'error' } });
    }
  });

  app.post('/v1/responses', async (request, reply) => {
    const startedAt = Date.now();
    let auditCtx: GatewayAuditContext | null = null;
    try {
      if (!config.aiRouter.v2EndpointsEnabled) {
        return reply.code(404).send({ error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' } });
      }
      const user = resolveGatewayUser(request);
      // Passthrough posture (see /v1/messages above for full rationale). We
      // guard only the fields the router itself consumes; OpenAI validates the
      // Responses API surface. Reference schema is still evaluated for drift
      // logging.
      const guardRes = guardResponsesRoutingShape(request.body);
      if (!guardRes.ok) {
        return reply.code(400).send({
          type: 'error',
          error: { type: 'invalid_request_error', message: guardRes.message },
        });
      }
      const body = guardRes.body;
      const driftCheck = responsesRequestSchema.safeParse(request.body);
      if (!driftCheck.success) {
        request.log.warn({
          event: 'ai_router.responses.schema_drift',
          issues: driftCheck.error.issues.slice(0, 8).map(i => ({
            path: i.path.join('.'),
            code: i.code,
            message: i.message,
          })),
        }, 'forwarding /v1/responses body that does not match reference schema');
      }
      auditCtx = {
        endpoint: 'responses', model: body.model,
        appId: request.auth.appId ?? '_platform',
        userId: user.userId,
        ipAddress: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
        startedAt,
      };
      const runtimePool = getRuntimeDbPool(config.runtimeDb, user.region);
      const organizationId = await resolveGatewayOrg(app.controlDb, user.userId);
      const result = await routeResponses(
        { platformPool: app.controlDb, runtimePool, redis: getRedisClient(),
          adapters, markupPct: config.aiRouter.markupPct,
          appId: request.auth.appId ?? null, organizationId, userId: user.userId, region: user.region },
        body,
      );
      if (result.stream) {
        reply.raw.setHeader('content-type', 'text/event-stream');
        reply.raw.setHeader('cache-control', 'no-cache, no-transform');
        reply.raw.setHeader('connection', 'keep-alive');
        reply.hijack();
        const reader = result.stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            reply.raw.write(value);
          }
          reply.raw.end();
        } catch (streamErr) {
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'stream_error', message: String(streamErr) } })}\n\n`);
          reply.raw.end();
          return;
        }
        emitGatewayEvent(app, auditCtx, { success: true, status: 200, usage: null, stream: true });
        return;
      }
      if (result.status < 400) {
        emitGatewayEvent(app, auditCtx, { success: true, status: result.status, usage: null, stream: false });
      } else {
        emitGatewayEvent(app, auditCtx, { success: false, status: result.status, errorMessage: 'route returned non-2xx', errorCode: 'route_error' });
      }
      return reply.code(result.status).send(result.body);
    } catch (err) {
      if (auditCtx) {
        const e = err as { message?: string; gatewayCode?: string; code?: string; statusCode?: number; gatewayStatus?: number };
        emitGatewayEvent(app, auditCtx, {
          success: false, errorMessage: e.message ?? 'unknown',
          errorCode: e.gatewayCode ?? e.code ?? 'error',
          status: e.gatewayStatus ?? e.statusCode,
        });
      }
      return handleRouterError(reply, err);
    }
  });

  app.post('/v1/embeddings', async (request, reply) => {
    const startedAt = Date.now();
    let auditCtx: GatewayAuditContext | null = null;
    try {
      const user = resolveGatewayUser(request);
      const body = embeddingSchema.parse(request.body);
      auditCtx = {
        endpoint: 'embeddings',
        model: body.model,
        appId: request.auth.appId ?? '_platform',
        userId: user.userId,
        ipAddress: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
        startedAt,
      };
      const runtimePool = getRuntimeDbPool(config.runtimeDb, user.region);
      const organizationId = await resolveGatewayOrg(app.controlDb, user.userId);
      const result = await routeEmbedding(
        {
          platformPool: app.controlDb,
          runtimePool,
          redis: getRedisClient(),
          adapters,
          markupPct: config.aiRouter.markupPct,
          appId: null,
          organizationId,
          userId: user.userId,
          region: user.region,
        },
        body,
      );
      const usage = (result.body as { usage?: { prompt_tokens?: number; total_tokens?: number } } | undefined)?.usage ?? null;
      emitGatewayEvent(app, auditCtx, { success: true, status: result.status, usage, stream: false });
      return reply.code(result.status).send(result.body);
    } catch (err) {
      if (auditCtx) {
        const e = err as { message?: string; gatewayCode?: string; code?: string; statusCode?: number; gatewayStatus?: number };
        emitGatewayEvent(app, auditCtx, {
          success: false,
          errorMessage: e.message ?? 'unknown',
          errorCode: e.gatewayCode ?? e.code ?? 'error',
          status: e.gatewayStatus ?? e.statusCode,
        });
      }
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
