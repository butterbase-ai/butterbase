import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyEndUserJwt } from '../services/end-user-auth.js';
import { getAgent } from '../services/agents-service.js';
import { payloadHashBuf } from '../utils/canonical-json.js';
import {
  createRun, getRunById, findRunByIdempotencyKey,
} from '../services/agent-runs-service.js';
import {
  startRun as startRunRemote,
  cancelRun as cancelRunRemote,
  resumeRun as resumeRunRemote,
} from '../services/agent-runtime-client.js';
import { applyAllLimits } from '../services/agent-rate-limits.js';
import { getRedisClient } from '../services/redis.js';
import { mintEndUserStreamToken, verifyEndUserStreamToken } from '../services/agent-stream-tokens.js';
import { getOrCreateSigningKey } from '../services/auth/signing-key-service.js';
import { streamRunEventsAsSse, streamRunEventsToWebSocket } from '../services/agent-event-stream.js';

/** Represents an end-user caller resolved from the public auth header. */
interface PublicCaller {
  kind: 'end_user';
  userId: string | null;
  ip: string | null;
}

type ResolveResult =
  | ({ ok: true } & PublicCaller)
  | { ok: false; code: number; error: string };

/**
 * Resolves the caller identity from a public-facing request.
 *
 * Auth priority:
 *  1. Authorization: Bearer <token>  → verify end-user JWT
 *  2. apikey header                  → match apps.anon_key (public visibility only)
 *  3. Neither                        → 401
 *
 * Private agents are rejected before any credential check.
 */
async function resolvePublicCaller(
  app: FastifyInstance,
  request: FastifyRequest,
  appId: string,
  agentVisibility: string,
): Promise<ResolveResult> {
  if (agentVisibility === 'private') {
    return { ok: false, code: 403, error: 'Agent is not publicly invocable' };
  }

  const ip = request.ip ?? null;

  const authHeader = request.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const claims = await verifyEndUserJwt(app.controlDb, appId, token);
      return { ok: true, kind: 'end_user', userId: claims.sub ?? null, ip };
    } catch {
      return { ok: false, code: 401, error: 'Invalid app JWT' };
    }
  }

  const anonKey = request.headers['apikey'];
  if (anonKey) {
    if (agentVisibility !== 'public') {
      return { ok: false, code: 403, error: 'Agent is not publicly invocable' };
    }
    const r = await app.controlDb.query(
      'SELECT 1 FROM apps WHERE id = $1 AND anon_key = $2',
      [appId, anonKey],
    );
    if (r.rows.length === 0) {
      return { ok: false, code: 401, error: 'Invalid anon key' };
    }
    return { ok: true, kind: 'end_user', userId: null, ip };
  }

  return { ok: false, code: 401, error: 'Missing app JWT or anon key' };
}

/**
 * Zod schema for the run-create request body.
 * Kept in the skeleton so Task 14+ handlers can import it without moving it.
 */
export const runCreateBody = z.object({
  input: z.unknown(),
  webhook_url: z.string().url().optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
});

/**
 * Public-route plugin for end-user agent invocation.
 */
export async function agentPublicRoutes(app: FastifyInstance) {
  app.post('/v1/:appId/public/agents/:name/runs', async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };

    const agent = await getAgent(app.controlDb, appId, name);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    if (agent.status !== 'active') return reply.code(400).send({ error: 'Agent is disabled' });

    const authed = await resolvePublicCaller(app, request, appId, agent.visibility);
    if (!authed.ok) return reply.code(authed.code).send({ error: authed.error });

    const parsed = runCreateBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }

    // Idempotency 409 (same logic as owner route).
    const newHash = payloadHashBuf(parsed.data.input);
    if (parsed.data.idempotency_key) {
      const existing = await findRunByIdempotencyKey(
        app.controlDb, appId, parsed.data.idempotency_key,
      );
      if (existing) {
        const sameHash = existing.payload_hash != null
          && Buffer.compare(existing.payload_hash, newHash) === 0;
        if (sameHash) {
          // Mint fresh stream token for the existing run.
          const pk = (await getOrCreateSigningKey(app.controlDb, appId)).privateKey;
          const tok = await mintEndUserStreamToken(
            pk, appId, existing.id, authed.userId, 15 * 60,
          );
          return reply.code(202).send({
            run_id: existing.id, status: existing.status,
            stream_token: tok,
            expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          });
        }
        return reply.code(409).send({
          error: 'idempotency_key_reuse', existing_run_id: existing.id,
        });
      }
    }

    // Rate limit / budget check.
    const redis = getRedisClient();
    const decision = await applyAllLimits(
      redis, app.controlDb, agent,
      { userId: authed.userId, ip: authed.ip },
    );
    if (!decision.allowed) {
      const retryAfter = decision.resetAt
        ? Math.max(decision.resetAt - Math.floor(Date.now() / 1000), 1)
        : 60;
      reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({
        error: 'rate_limit_exceeded',
        limit: decision.reason,
        current: decision.current ?? null,
        max: decision.max ?? null,
        reset_at: decision.resetAt
          ? new Date(decision.resetAt * 1000).toISOString() : null,
      });
    }

    const run = await createRun(app.controlDb, appId, agent.id, {
      caller_kind: 'end_user',
      caller_user_id: authed.userId ?? undefined,
      caller_ip: authed.ip ?? undefined,
      input: parsed.data.input,
      webhook_url: parsed.data.webhook_url,
      idempotency_key: parsed.data.idempotency_key,
      payload_hash: newHash,
    });

    try {
      await startRunRemote(run.id);
    } catch (err) {
      app.log.error({ err, runId: run.id }, 'agent-runtime start failed (public)');
      await app.controlDb.query(
        `UPDATE agent_runs SET status='failed', error=$2::jsonb, finished_at=now()
          WHERE id=$1 AND status='queued'`,
        [run.id, JSON.stringify({
          message: err instanceof Error ? err.message : String(err),
          type: 'AgentRuntimeStartFailed',
        })],
      );
    }

    const pk = (await getOrCreateSigningKey(app.controlDb, appId)).privateKey;
    const tok = await mintEndUserStreamToken(
      pk, appId, run.id, authed.userId, 15 * 60,
    );
    const final = await getRunById(app.controlDb, appId, run.id);
    return reply.code(202).send({
      run_id: run.id,
      status: final?.status ?? 'queued',
      stream_token: tok,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
  });

  // ── Helpers for run lifecycle endpoints ──────────────────────────────────

  function sameCallerOrReject(
    run: { caller_kind: string; caller_user_id: string | null },
    caller: PublicCaller,
  ): { ok: true } | { ok: false; code: number; error: string } {
    if (run.caller_kind !== 'end_user') {
      return { ok: false, code: 403, error: 'Run not invoked by end-user' };
    }
    // Anon-started runs can't be cancelled/resumed from the public path.
    if (run.caller_user_id == null) {
      return { ok: false, code: 403, error: 'Anon runs cannot be modified from public path' };
    }
    if (run.caller_user_id !== caller.userId) {
      return { ok: false, code: 403, error: 'Caller mismatch' };
    }
    return { ok: true };
  }

  async function loadRunForReadAccess(
    appId: string, runId: string, caller: PublicCaller,
  ) {
    const run = await getRunById(app.controlDb, appId, runId);
    if (!run) return { ok: false as const, code: 404, error: 'Run not found' };
    if (run.caller_kind !== 'end_user') {
      return { ok: false as const, code: 404, error: 'Run not found' };
    }
    // Read access: anon-anon allowed; otherwise same caller_user_id required.
    if (run.caller_user_id == null && caller.userId == null) return { ok: true as const, run };
    if (run.caller_user_id === caller.userId) return { ok: true as const, run };
    return { ok: false as const, code: 403, error: 'Caller mismatch' };
  }

  // ── GET /v1/:appId/public/runs/:id ───────────────────────────────────────

  app.get('/v1/:appId/public/runs/:id', async (request, reply) => {
    const { appId, id } = request.params as { appId: string; id: string };
    const r = await app.controlDb.query(
      'SELECT a.visibility FROM agent_runs r JOIN agents a ON r.agent_id = a.id WHERE r.id = $1 AND r.app_id = $2',
      [id, appId],
    );
    if (r.rows.length === 0) return reply.code(404).send({ error: 'Run not found' });
    const authed = await resolvePublicCaller(app, request, appId, r.rows[0].visibility);
    if (!authed.ok) return reply.code(authed.code).send({ error: authed.error });

    const caller: PublicCaller = { kind: authed.kind, userId: authed.userId, ip: authed.ip };
    const access = await loadRunForReadAccess(appId, id, caller);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    return reply.code(200).send({ run: access.run });
  });

  // ── POST /v1/:appId/public/runs/:id/cancel ───────────────────────────────

  app.post('/v1/:appId/public/runs/:id/cancel', async (request, reply) => {
    const { appId, id } = request.params as { appId: string; id: string };
    const r = await app.controlDb.query(
      'SELECT a.visibility FROM agent_runs r JOIN agents a ON r.agent_id = a.id WHERE r.id = $1 AND r.app_id = $2',
      [id, appId],
    );
    if (r.rows.length === 0) return reply.code(404).send({ error: 'Run not found' });
    const authed = await resolvePublicCaller(app, request, appId, r.rows[0].visibility);
    if (!authed.ok) return reply.code(authed.code).send({ error: authed.error });

    const run = await getRunById(app.controlDb, appId, id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const caller: PublicCaller = { kind: authed.kind, userId: authed.userId, ip: authed.ip };
    const match = sameCallerOrReject(run, caller);
    if (!match.ok) return reply.code(match.code).send({ error: match.error });
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return reply.code(409).send({ error: `Run already terminal (status: ${run.status})` });
    }
    await cancelRunRemote(run.id);
    return reply.code(202).send({ run_id: run.id, status: 'cancelling' });
  });

  // ── POST /v1/:appId/public/runs/:id/resume ───────────────────────────────

  app.post('/v1/:appId/public/runs/:id/resume', async (request, reply) => {
    const { appId, id } = request.params as { appId: string; id: string };
    const r = await app.controlDb.query(
      'SELECT a.visibility FROM agent_runs r JOIN agents a ON r.agent_id = a.id WHERE r.id = $1 AND r.app_id = $2',
      [id, appId],
    );
    if (r.rows.length === 0) return reply.code(404).send({ error: 'Run not found' });
    const authed = await resolvePublicCaller(app, request, appId, r.rows[0].visibility);
    if (!authed.ok) return reply.code(authed.code).send({ error: authed.error });

    const run = await getRunById(app.controlDb, appId, id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const caller: PublicCaller = { kind: authed.kind, userId: authed.userId, ip: authed.ip };
    const match = sameCallerOrReject(run, caller);
    if (!match.ok) return reply.code(match.code).send({ error: match.error });
    if (run.status !== 'paused') {
      return reply.code(409).send({ error: `Run is not paused (current status: ${run.status})` });
    }
    const parsed = z.object({ input: z.unknown() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });
    await resumeRunRemote(run.id, parsed.data.input);
    return reply.code(202).send({ run_id: run.id, status: 'queued' });
  });

  // ── GET /v1/:appId/public/runs/:id/events.json ───────────────────────────

  app.get('/v1/:appId/public/runs/:id/events.json', async (request, reply) => {
    const { appId, id } = request.params as { appId: string; id: string };
    const r = await app.controlDb.query(
      'SELECT a.visibility FROM agent_runs r JOIN agents a ON r.agent_id = a.id WHERE r.id = $1',
      [id],
    );
    if (r.rows.length === 0) return reply.code(404).send({ error: 'Run not found' });
    const authed = await resolvePublicCaller(app, request, appId, r.rows[0].visibility);
    if (!authed.ok) return reply.code(authed.code).send({ error: authed.error });
    const caller: PublicCaller = { kind: authed.kind, userId: authed.userId, ip: authed.ip };
    const access = await loadRunForReadAccess(appId, id, caller);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });

    const sinceSeq = Number((request.query as { since_seq?: string }).since_seq ?? 0);
    const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 100), 500);
    const ev = await app.controlDb.query(
      `SELECT seq, type, payload, created_at FROM agent_run_events
        WHERE run_id = $1::uuid AND seq > $2 ORDER BY seq LIMIT $3`,
      [id, sinceSeq, limit],
    );
    return { events: ev.rows };
  });

  // ── POST /v1/:appId/public/runs/:id/stream-token ─────────────────────────

  app.post('/v1/:appId/public/runs/:id/stream-token', async (request, reply) => {
    const { appId, id } = request.params as { appId: string; id: string };
    const r = await app.controlDb.query(
      'SELECT a.visibility FROM agent_runs r JOIN agents a ON r.agent_id = a.id WHERE r.id = $1',
      [id],
    );
    if (r.rows.length === 0) return reply.code(404).send({ error: 'Run not found' });
    const authed = await resolvePublicCaller(app, request, appId, r.rows[0].visibility);
    if (!authed.ok) return reply.code(authed.code).send({ error: authed.error });
    const caller: PublicCaller = { kind: authed.kind, userId: authed.userId, ip: authed.ip };
    const access = await loadRunForReadAccess(appId, id, caller);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });

    const pk = (await getOrCreateSigningKey(app.controlDb, appId)).privateKey;
    const tok = await mintEndUserStreamToken(pk, appId, id, authed.userId, 15 * 60);
    return {
      stream_token: tok,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  });

  // ── GET /v1/:appId/public/runs/:id/events (SSE) ──────────────────────────

  app.get('/v1/:appId/public/runs/:id/events', async (request, reply) => {
    const { appId, id } = request.params as { appId: string; id: string };
    const token = (request.query as { token?: string }).token;
    if (!token) return reply.code(401).send({ error: 'Missing token' });
    const pk = (await getOrCreateSigningKey(app.controlDb, appId)).privateKey;
    try {
      await verifyEndUserStreamToken(pk, appId, id, token);
    } catch {
      return reply.code(401).send({ error: 'Invalid stream token' });
    }
    const sinceSeq = Number((request.query as { since_seq?: string }).since_seq ?? 0);
    await streamRunEventsAsSse(app, request, reply, id, sinceSeq);
    // Do not return — connection stays open.
  });

  // ── GET /v1/:appId/public/runs/:id/events/ws (WebSocket) ─────────────────

  app.get(
    '/v1/:appId/public/runs/:id/events/ws',
    { websocket: true } as Parameters<typeof app.get>[1],
    async (socket, request) => {
      const { appId, id } = request.params as { appId: string; id: string };
      const token = (request.query as { token?: string }).token;
      if (!token) {
        socket.close(4401, 'missing token');
        return;
      }
      try {
        const pk = (await getOrCreateSigningKey(app.controlDb, appId)).privateKey;
        await verifyEndUserStreamToken(pk, appId, id, token);
      } catch {
        socket.close(4401, 'invalid token');
        return;
      }
      const sinceSeq = Number((request.query as { since_seq?: string }).since_seq ?? 0);
      await streamRunEventsToWebSocket(app, socket, id, sinceSeq);
    },
  );
}
