// services/control-api/src/routes/ai-meetings.ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { encrypt } from '../services/crypto.js';
import { config } from '../config.js';
import {
  getActorProvider,
} from '../services/actor-providers/registry.js';
import {
  ProviderUnavailableError, ActorProviderError,
} from '../services/actor-providers/types.js';
import {
  reserveActorCredits,
} from '../services/actor-providers/billing.js';
import { InsufficientCreditsError } from '../services/ai-router/billing-gate.js';
import {
  startMeetingsRequestSchema, listMeetingsRequestSchema,
} from '../services/actor-providers/schemas.js';
import { logAuditEvent } from '../services/audit/audit-events-service.js';
import { requireUserId } from '../utils/require-auth.js';
import { resolveAppHomeRegion, getRuntimeDbForApp } from '../services/region-resolver.js';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';

const GATEWAY_SCOPE = 'ai:gateway';

interface GatewayUser { userId: string; appId: string; region: string; }

// appId comes from the URL path (e.g. /v1/:appId/ai/meetings). The route
// must verify that the authenticated caller owns the app before any
// provider call. bb_sk_ keys carry userId only (not appId), so wiring the
// app context through auth.appId is not viable for this surface; the path
// is the source of truth.
async function resolveGatewayUser(
  app: FastifyInstance,
  req: FastifyRequest,
  appId: string,
): Promise<GatewayUser> {
  const { userId, authMethod, scopes } = req.auth;
  if (!userId) {
    const e: any = new Error('missing_credentials');
    e.gatewayStatus = 401; e.gatewayCode = 'missing_credentials';
    throw e;
  }
  if (authMethod === 'api_key' && !scopes.includes('*') && !scopes.includes(GATEWAY_SCOPE)) {
    const e: any = new Error('insufficient_scope');
    e.gatewayStatus = 403; e.gatewayCode = 'insufficient_scope';
    throw e;
  }
  try {
    await AppResolver.resolveApp((app as any).controlDb, appId, userId, req.auth?.organizationId ?? null);
  } catch (err) {
    if (err instanceof AppNotFoundError) {
      const e: any = new Error('app_not_found');
      e.gatewayStatus = 404; e.gatewayCode = 'app_not_found';
      throw e;
    }
    throw err;
  }
  return { userId, appId, region: config.aiRouter.defaultRegion };
}

function openaiError(message: string, type: string, code: string, extra?: Record<string, unknown>) {
  return { error: { message, type, code, ...(extra ?? {}) } };
}

function handleError(reply: FastifyReply, err: unknown) {
  if ((err as any).gatewayStatus) {
    const e = err as any;
    const type = e.gatewayStatus === 401
      ? 'authentication_error'
      : e.gatewayStatus === 403 ? 'permission_error' : 'api_error';
    return reply.code(e.gatewayStatus).send(openaiError(e.gatewayCode, type, e.gatewayCode));
  }
  if (err instanceof ProviderUnavailableError) {
    return reply.code(501).send(openaiError(err.message, 'api_error', 'provider_unavailable'));
  }
  if (err instanceof InsufficientCreditsError) {
    return reply.code(402).send(openaiError(
      err.message, 'billing_error', 'insufficient_credits',
      { required_usd: err.requiredUsd, available_usd: err.availableUsd },
    ));
  }
  if (err instanceof ActorProviderError) {
    return reply.code(err.statusCode).send(openaiError(err.message, 'api_error', err.code));
  }
  if (err instanceof z.ZodError) {
    return reply.code(400).send(openaiError('Invalid request body', 'invalid_request_error', 'invalid_request', { details: err.errors }));
  }
  console.error('[ai-meetings] unhandled', err);
  return reply.code(500).send(openaiError('Internal error', 'api_error', 'internal_error'));
}

export async function aiMeetingsRoutes(app: FastifyInstance) {
  app.post<{ Params: { appId: string } }>('/v1/:appId/ai/meetings', async (req, reply) => {
    try {
      const user = await resolveGatewayUser(app, req, req.params.appId);
      const body = startMeetingsRequestSchema.parse(req.body);
      const provider = getActorProvider('meetings');
      const handle = await reserveActorCredits((app as any).controlDb, {
        userId: user.userId, region: user.region,
        recordingUsdPerSecond: provider.recordingUsdPerSecond,
        transcriptionUsdPerSecond: provider.transcriptionUsdPerSecond,
        transcript: body.transcript,
        markupPct: config.aiRouter.markupPct,
      });
      const bot = await provider.start(
        { appId: user.appId, userId: user.userId, leaseId: handle.leaseId },
        body,
      );
      void logAuditEvent((app as any).controlDb, {
        appId: user.appId,
        category: 'ai',
        eventType: 'ai_meetings.start',
        action: 'invoke',
        resourceType: 'ai_request',
        resourceId: bot.id,
        actorType: 'platform_user',
        actorId: user.userId,
        eventData: {
          transcript: body.transcript,
          recording: body.recording,
          lease_id: handle.leaseId,
        },
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        success: true,
        errorMessage: null,
      });
      return reply.code(200).send(bot);
    } catch (err) {
      void logAuditEvent((app as any).controlDb, {
        appId: req.params.appId ?? '_unknown',
        category: 'ai',
        eventType: 'ai_meetings.start',
        action: 'invoke',
        resourceType: 'ai_request',
        resourceId: undefined,
        actorType: 'platform_user',
        actorId: req.auth?.userId ?? '_unknown',
        eventData: { error_code: (err as any).code ?? (err as any).gatewayCode ?? 'error' },
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        success: false,
        errorMessage: (err as any).message ?? 'unknown',
      });
      return handleError(reply, err);
    }
  });

  app.get<{ Params: { appId: string; id: string } }>('/v1/:appId/ai/meetings/:id', async (req, reply) => {
    try {
      const user = await resolveGatewayUser(app, req, req.params.appId);
      const provider = getActorProvider('meetings');
      const bot = await provider.get(
        { appId: user.appId, userId: user.userId, leaseId: '' },
        req.params.id,
      );
      return reply.code(200).send(bot);
    } catch (err) { return handleError(reply, err); }
  });

  app.delete<{ Params: { appId: string; id: string } }>('/v1/:appId/ai/meetings/:id', async (req, reply) => {
    try {
      const user = await resolveGatewayUser(app, req, req.params.appId);
      const provider = getActorProvider('meetings');
      await provider.stop(
        { appId: user.appId, userId: user.userId, leaseId: '' },
        req.params.id,
      );
      return reply.code(204).send();
    } catch (err) { return handleError(reply, err); }
  });

  app.get<{ Params: { appId: string } }>('/v1/:appId/ai/meetings', async (req, reply) => {
    try {
      const user = await resolveGatewayUser(app, req, req.params.appId);
      const query = listMeetingsRequestSchema.parse(req.query);
      const provider = getActorProvider('meetings');
      const out = await provider.list(
        { appId: user.appId, userId: user.userId, leaseId: '' },
        query,
      );
      return reply.code(200).send(out);
    } catch (err) { return handleError(reply, err); }
  });

  app.get('/v1/ai/meetings/_status', { config: { public: true } }, async (_req, reply) => {
    try {
      getActorProvider('meetings');
      return reply.send({ available: true });
    } catch {
      return reply.send({ available: false });
    }
  });

  app.get<{ Params: { appId: string } }>('/v1/:appId/ai/meetings/_estimate', async (req, reply) => {
    try {
      await resolveGatewayUser(app, req, req.params.appId);
      const q = z.object({
        durationMinutes: z.coerce.number().int().min(1).max(24 * 60),
        transcript: z.coerce.boolean().default(true),
      }).parse(req.query);
      const provider = getActorProvider('meetings');
      const out = provider.estimateCost({
        durationMinutes: q.durationMinutes,
        transcript: q.transcript,
        markupPct: config.aiRouter.markupPct,
      });
      return reply.code(200).send(out);
    } catch (err) { return handleError(reply, err); }
  });

  // Return the last 100 rows from actor_usage_logs for the given app.
  app.get<{ Params: { appId: string } }>('/v1/:appId/ai/meetings/usage', async (req, reply) => {
    const { appId } = req.params;
    const userId = requireUserId(req);
    try {
      const region = await resolveAppHomeRegion((app as any).controlDb, appId);
      const runtimeDb = await getRuntimeDbForApp((app as any).controlDb, appId);
      const ownerResult = await runtimeDb.query(
        'SELECT owner_id FROM apps WHERE id = $1',
        [appId],
      );
      if (ownerResult.rows.length === 0) {
        return reply.code(404).send({ error: 'App not found' });
      }
      if (ownerResult.rows[0].owner_id !== userId) {
        return reply.code(403).send({ error: 'Not authorized' });
      }
      const rows = await runtimeDb.query(
        `SELECT id, dimension, seconds, usd_charged, created_at
           FROM actor_usage_logs
          WHERE app_id = $1
          ORDER BY created_at DESC
          LIMIT 100`,
        [appId],
      );
      return reply.code(200).send({ rows: rows.rows });
    } catch (err) {
      app.log.error({ err }, '[ai-meetings] usage fetch failed');
      return reply.code(500).send({ error: 'Internal error' });
    }
  });

  // Configure the app's meetings webhook forward URL and (optionally) rotate the signing secret.
  const meetingsWebhookBodySchema = z.object({
    forward_url: z.string().url(),
    rotate_secret: z.boolean().optional(),
  });

  app.put<{ Params: { appId: string } }>('/v1/:appId/ai/meetings/webhook', async (req, reply) => {
    const { appId } = req.params;
    const userId = requireUserId(req);

    try {
      const body = meetingsWebhookBodySchema.parse(req.body);

      // Verify ownership
      const region = await resolveAppHomeRegion((app as any).controlDb, appId);
      const runtimeDb = await getRuntimeDbForApp((app as any).controlDb, appId);
      const ownerResult = await runtimeDb.query(
        'SELECT owner_id FROM apps WHERE id = $1',
        [appId],
      );
      if (ownerResult.rows.length === 0) {
        return reply.code(404).send({ error: 'App not found' });
      }
      if (ownerResult.rows[0].owner_id !== userId) {
        return reply.code(403).send({ error: 'Not authorized' });
      }

      const encryptionKey = process.env.AUTH_ENCRYPTION_KEY;
      if (!encryptionKey) {
        app.log.error('[ai-meetings] AUTH_ENCRYPTION_KEY not set; cannot persist webhook secret');
        return reply.code(500).send({ error: 'Server encryption not configured' });
      }

      // Check for existing row
      const existing: { rows: { forward_secret_encrypted: string }[] } =
        await (app as any).controlDb.query(
          'SELECT forward_secret_encrypted FROM app_meetings_webhooks WHERE app_id = $1',
          [appId],
        );

      let rawSecret: string | null = null;
      let secretEncrypted: string;

      if (body.rotate_secret || existing.rows.length === 0) {
        // Generate a new secret: wsec_<base64url(32 random bytes)>.
        // We store the AES-256-GCM ciphertext so the forwarder can decrypt
        // and HMAC-sign outbound payloads with it; receivers verify with the
        // same raw value handed back here (one-time on create / rotate).
        const raw = randomBytes(32).toString('base64url');
        rawSecret = `wsec_${raw}`;
        secretEncrypted = encrypt(rawSecret, encryptionKey);
      } else {
        secretEncrypted = existing.rows[0].forward_secret_encrypted;
      }

      // Upsert
      await (app as any).controlDb.query(
        `INSERT INTO app_meetings_webhooks (app_id, forward_url, forward_secret_encrypted, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (app_id) DO UPDATE
           SET forward_url = EXCLUDED.forward_url,
               forward_secret_encrypted = EXCLUDED.forward_secret_encrypted,
               updated_at = now()`,
        [appId, body.forward_url, secretEncrypted],
      );

      return reply.code(200).send({
        ok: true,
        app_id: appId,
        forward_url: body.forward_url,
        secret: rawSecret,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request', details: err.errors });
      }
      app.log.error({ err }, '[ai-meetings] configure webhook failed');
      return reply.code(500).send({ error: 'Internal error' });
    }
  });
}
