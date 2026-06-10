// services/control-api/src/routes/ai-meetings.ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
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

const GATEWAY_SCOPE = 'ai:gateway';

interface GatewayUser { userId: string; appId: string; region: string; }

function resolveGatewayUser(req: FastifyRequest): GatewayUser {
  const { userId, appId, authMethod, scopes } = req.auth;
  if (!userId || !appId) {
    const e: any = new Error('missing_credentials');
    e.gatewayStatus = 401; e.gatewayCode = 'missing_credentials';
    throw e;
  }
  if (authMethod === 'api_key' && !scopes.includes('*') && !scopes.includes(GATEWAY_SCOPE)) {
    const e: any = new Error('insufficient_scope');
    e.gatewayStatus = 403; e.gatewayCode = 'insufficient_scope';
    throw e;
  }
  return { userId, appId, region: config.aiRouter.defaultRegion };
}

function openaiError(message: string, type: string, code: string, extra?: Record<string, unknown>) {
  return { error: { message, type, code, ...(extra ?? {}) } };
}

function handleError(reply: FastifyReply, err: unknown) {
  if ((err as any).gatewayStatus) {
    const e = err as any;
    return reply.code(e.gatewayStatus).send(openaiError(e.gatewayCode, 'authentication_error', e.gatewayCode));
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
  app.post('/v1/ai/meetings', async (req, reply) => {
    try {
      const user = resolveGatewayUser(req);
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
      return reply.code(200).send(bot);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/v1/ai/meetings/:id', async (req, reply) => {
    try {
      const user = resolveGatewayUser(req);
      const provider = getActorProvider('meetings');
      const bot = await provider.get(
        { appId: user.appId, userId: user.userId, leaseId: '' },
        req.params.id,
      );
      return reply.code(200).send(bot);
    } catch (err) { return handleError(reply, err); }
  });

  app.delete<{ Params: { id: string } }>('/v1/ai/meetings/:id', async (req, reply) => {
    try {
      const user = resolveGatewayUser(req);
      const provider = getActorProvider('meetings');
      await provider.stop(
        { appId: user.appId, userId: user.userId, leaseId: '' },
        req.params.id,
      );
      return reply.code(204).send();
    } catch (err) { return handleError(reply, err); }
  });

  app.get('/v1/ai/meetings', async (req, reply) => {
    try {
      const user = resolveGatewayUser(req);
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
}
