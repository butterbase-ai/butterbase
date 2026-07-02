import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { getAgent } from '../services/agents-service.js';
import { getRunById } from '../services/agent-runs-service.js';
import { streamRunEventsAsSse, streamRunEventsToWebSocket } from '../services/agent-event-stream.js';
import { verifyEndUserStreamToken } from '../services/agent-stream-tokens.js';
import { getOrCreateSigningKey } from '../services/auth/signing-key-service.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';

async function resolveRuntime(
  app: FastifyInstance,
  appId: string,
): Promise<
  | { ok: true; runtimeDb: Pool }
  | { ok: false; code: number; error: string }
> {
  try {
    const runtimeDb = await getRuntimeDbForApp(app.controlDb, appId);
    return { ok: true, runtimeDb };
  } catch (err: any) {
    const code: string = err?.code ?? err?.name ?? '';
    if (code === 'APP_NOT_FOUND') return { ok: false, code: 404, error: 'App not found' };
    if (code === 'APP_PROVISIONING') {
      return { ok: false, code: 503, error: 'App database is still being provisioned' };
    }
    throw err;
  }
}

/**
 * Unified auth for owner-facing stream routes.
 *
 * Path 1: owner JWT/API-key in Authorization header or cookie. request.auth
 *   is set by the auth plugin — read owner_id from runtime-plane.apps to
 *   verify ownership.
 *
 * Path 2: short-lived stream token in ?token= query param (browser
 *   EventSource cannot send custom headers).
 */
async function authForOwnerStream(
  app: FastifyInstance,
  runtimeDb: Pool,
  request: FastifyRequest,
  appId: string,
  runId: string,
): Promise<{ ok: true } | { ok: false; code: number; error: string }> {
  if (request.auth?.userId) {
    try {
      await AppResolver.resolveApp(app.controlDb, appId, request.auth.userId);
      return { ok: true };
    } catch (err) {
      if (err instanceof AppNotFoundError) return { ok: false, code: 404, error: 'App not found' };
      throw err;
    }
  }

  const token = (request.query as { token?: string })?.token;
  if (!token) return { ok: false, code: 401, error: 'Missing auth' };
  try {
    // getOrCreateSigningKey resolves runtime-plane itself; keep controlDb here.
    const { privateKey } = await getOrCreateSigningKey(app.controlDb, appId);
    await verifyEndUserStreamToken(privateKey, appId, runId, token);
    return { ok: true };
  } catch {
    return { ok: false, code: 401, error: 'Invalid stream token' };
  }
}

export async function agentStreamsRoutes(app: FastifyInstance) {
  // SSE: GET /v1/:appId/agents/:name/runs/:id/events
  app.get('/v1/:appId/agents/:name/runs/:id/events', async (request, reply) => {
    const { appId, name, id } = request.params as { appId: string; name: string; id: string };
    const ctx = await resolveRuntime(app, appId);
    if (!ctx.ok) return reply.code(ctx.code).send({ error: ctx.error });
    const { runtimeDb } = ctx;

    const authed = await authForOwnerStream(app, runtimeDb, request, appId, id);
    if (!authed.ok) return reply.code(authed.code).send({ error: authed.error });

    const agent = await getAgent(runtimeDb, appId, name);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const run = await getRunById(runtimeDb, appId, id);
    if (!run || run.agent_id !== agent.id) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    const sinceSeq = Number((request.query as Record<string, string>)?.since_seq ?? 0);
    await streamRunEventsAsSse(runtimeDb, request, reply, id, sinceSeq);
  });

  // WebSocket: GET /v1/:appId/agents/:name/runs/:id/ws
  app.get(
    '/v1/:appId/agents/:name/runs/:id/ws',
    { websocket: true },
    async (socket, request) => {
      const { appId, name, id } = request.params as { appId: string; name: string; id: string };
      const ctx = await resolveRuntime(app, appId);
      if (!ctx.ok) {
        socket.close(1008, ctx.error);
        return;
      }
      const { runtimeDb } = ctx;

      const authedWs = await authForOwnerStream(app, runtimeDb, request, appId, id);
      if (!authedWs.ok) {
        socket.close(1008, 'unauthorized');
        return;
      }

      const agent = await getAgent(runtimeDb, appId, name);
      if (!agent) {
        socket.close(1008, 'not found');
        return;
      }

      const run = await getRunById(runtimeDb, appId, id);
      if (!run || run.agent_id !== agent.id) {
        socket.close(1008, 'not found');
        return;
      }

      const sinceSeq = Number((request.query as Record<string, string>)?.since_seq ?? 0);
      await streamRunEventsToWebSocket(runtimeDb, socket, id, sinceSeq);
    },
  );
}
