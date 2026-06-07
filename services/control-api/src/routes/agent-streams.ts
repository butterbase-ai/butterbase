import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAgent } from '../services/agents-service.js';
import { getRunById } from '../services/agent-runs-service.js';
import { streamRunEventsAsSse, streamRunEventsToWebSocket } from '../services/agent-event-stream.js';
import { verifyEndUserStreamToken } from '../services/agent-stream-tokens.js';
import { getOrCreateSigningKey } from '../services/auth/signing-key-service.js';

/**
 * Unified auth for owner-facing stream routes.
 *
 * Path 1 (existing): owner JWT/API-key in Authorization header or cookie.
 *   `request.auth.userId` is set by the auth plugin — verify app ownership.
 *
 * Path 2 (new): short-lived stream token in `?token=` query param.
 *   Allows browser EventSource (which cannot send custom headers) to connect.
 */
async function authForOwnerStream(
  app: FastifyInstance,
  request: FastifyRequest,
  appId: string,
  runId: string,
): Promise<{ ok: true } | { ok: false; code: number; error: string }> {
  // Header/cookie auth path (existing behavior — owner JWT).
  if (request.auth?.userId) {
    const r = await app.controlDb.query('SELECT owner_id FROM apps WHERE id = $1', [appId]);
    if (r.rows.length === 0) return { ok: false, code: 404, error: 'App not found' };
    if (r.rows[0].owner_id !== request.auth.userId) {
      return { ok: false, code: 403, error: 'Not authorized' };
    }
    return { ok: true };
  }

  // Token-via-query auth path (new — for browser EventSource).
  const token = (request.query as { token?: string })?.token;
  if (!token) return { ok: false, code: 401, error: 'Missing auth' };
  try {
    const { privateKey } = await getOrCreateSigningKey(app.controlDb, appId);
    await verifyEndUserStreamToken(privateKey, appId, runId, token);
    return { ok: true };
  } catch {
    return { ok: false, code: 401, error: 'Invalid stream token' };
  }
}

export async function agentStreamsRoutes(app: FastifyInstance) {
  // ──────────────────────────────────────────────────────────────────────────
  // SSE: GET /v1/:appId/agents/:name/runs/:id/events
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/v1/:appId/agents/:name/runs/:id/events', async (request, reply) => {
    const { appId, name, id } = request.params as { appId: string; name: string; id: string };

    const authed = await authForOwnerStream(app, request, appId, id);
    if (!authed.ok) return reply.code(authed.code).send({ error: authed.error });

    const agent = await getAgent(app.controlDb, appId, name);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const run = await getRunById(app.controlDb, appId, id);
    if (!run || run.agent_id !== agent.id) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    const sinceSeq = Number((request.query as Record<string, string>)?.since_seq ?? 0);

    // Delegate to shared helper (sets SSE headers, subscribes, tails).
    await streamRunEventsAsSse(app, request, reply, id, sinceSeq);
    // Do not return — Fastify keeps the connection open.
  });

  // ──────────────────────────────────────────────────────────────────────────
  // WebSocket: GET /v1/:appId/agents/:name/runs/:id/ws
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/v1/:appId/agents/:name/runs/:id/ws',
    { websocket: true },
    async (socket, request) => {
      const { appId, name, id } = request.params as { appId: string; name: string; id: string };

      // Auth + ownership checks
      const authedWs = await authForOwnerStream(app, request, appId, id);
      if (!authedWs.ok) {
        socket.close(1008, 'unauthorized');
        return;
      }

      const agent = await getAgent(app.controlDb, appId, name);
      if (!agent) {
        socket.close(1008, 'not found');
        return;
      }

      const run = await getRunById(app.controlDb, appId, id);
      if (!run || run.agent_id !== agent.id) {
        socket.close(1008, 'not found');
        return;
      }

      const sinceSeq = Number((request.query as Record<string, string>)?.since_seq ?? 0);

      // Delegate to shared helper.
      await streamRunEventsToWebSocket(app, socket, id, sinceSeq);
    },
  );
}
