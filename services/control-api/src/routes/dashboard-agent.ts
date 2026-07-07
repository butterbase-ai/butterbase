/**
 * Dashboard Assistant HTTP routes.
 *
 * Endpoints:
 *   POST   /conversations          – create a conversation
 *   GET    /conversations          – list caller's conversations
 *   GET    /conversations/:id      – get conversation + messages
 *   DELETE /conversations/:id      – delete conversation (204)
 *   POST   /messages               – SSE agent turn (streams LoopEvent frames)
 *
 * Feature flag: DASHBOARD_ASSISTANT_ENABLED must equal '1' or all routes
 * return 404.
 *
 * Auth: uses app.controlDb (pg.Pool) and requireUserId(request) which reads
 * request.auth.userId populated by the auth plugin (see plugins/auth.ts).
 *
 * Pool: app.controlDb (decorated by plugins/database.ts).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUserId } from '../utils/require-auth.js';
import {
  createConversation,
  listConversations,
  getConversation,
  deleteConversation,
  updateConversationModel,
  listMessages,
} from '../services/dashboard-agent/store.js';
import { runAgentTurn } from '../services/dashboard-agent/loop.js';

// ---------------------------------------------------------------------------
// Feature-flag guard
// ---------------------------------------------------------------------------

function isEnabled(): boolean {
  return process.env.DASHBOARD_ASSISTANT_ENABLED === '1';
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createConversationBody = z.object({
  title: z.string().min(1).max(500).default('New conversation'),
  model: z.string().min(1).default('claude-sonnet-4-5'),
});

const postMessageBody = z.object({
  conversation_id: z.string().uuid(),
  message: z.string().min(1),
  model: z.string().min(1).default('claude-sonnet-4-5'),
});

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function dashboardAgentRoutes(app: FastifyInstance) {
  // ── Startup env warnings ─────────────────────────────────────────────────
  if (process.env.DASHBOARD_ASSISTANT_ENABLED === '1') {
    if (!process.env.AI_GATEWAY_URL) {
      app.log.warn('DASHBOARD_ASSISTANT_ENABLED=1 but AI_GATEWAY_URL is unset; dashboard-agent chat turns will fail at runtime (defaulting to http://localhost:3000).');
    }
    if (!process.env.MCP_SERVER_URL) {
      app.log.warn('DASHBOARD_ASSISTANT_ENABLED=1 but MCP_SERVER_URL is unset; dashboard-agent tool calls will fail at runtime (defaulting to http://localhost:3010).');
    }
  }

  // ── POST /conversations ──────────────────────────────────────────────────
  app.post('/conversations', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);

    const parsed = createConversationBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const conversation = await createConversation(
      app.controlDb,
      userId,
      parsed.data.title,
      parsed.data.model,
    );

    return reply.code(201).send({ conversation });
  });

  // ── GET /conversations ───────────────────────────────────────────────────
  app.get('/conversations', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);

    const conversations = await listConversations(app.controlDb, userId);
    return reply.send({ conversations });
  });

  // ── GET /conversations/:id ───────────────────────────────────────────────
  app.get('/conversations/:id', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const conversation = await getConversation(app.controlDb, id, userId);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    const messages = await listMessages(app.controlDb, id);
    return reply.send({ conversation, messages });
  });

  // ── DELETE /conversations/:id ────────────────────────────────────────────
  app.delete('/conversations/:id', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const conversation = await getConversation(app.controlDb, id, userId);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    await deleteConversation(app.controlDb, id, userId);
    return reply.code(204).send();
  });

  // ── PATCH /conversations/:id — update model (persists picker choice) ────
  const patchConversationBody = z.object({
    model: z.string().min(1).max(200),
  });
  app.patch('/conversations/:id', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };
    const body = patchConversationBody.parse(request.body);

    const updated = await updateConversationModel(app.controlDb, id, userId, body.model);
    if (!updated) return reply.code(404).send({ error: 'conversation not found' });
    return reply.send({ conversation: updated });
  });

  // ── POST /messages (SSE agent turn) ─────────────────────────────────────
  app.post('/messages', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);

    const parsed = postMessageBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { conversation_id, message, model } = parsed.data;

    // Ownership check BEFORE sending SSE headers — once headers are sent we
    // cannot return a JSON 404.
    const conversation = await getConversation(app.controlDb, conversation_id, userId);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    // Extract JWT verbatim from Authorization header for the loop / gateway.
    const authHeader = request.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // Begin SSE response. reply.hijack() bypasses Fastify's onSend, which is where
    // @fastify/cors normally injects Access-Control-Allow-Origin. Reflect the caller
    // origin explicitly so browsers accept the stream.
    const requestOrigin = request.headers.origin;
    if (requestOrigin) {
      reply.raw.setHeader('access-control-allow-origin', requestOrigin);
      reply.raw.setHeader('vary', 'origin');
      reply.raw.setHeader('access-control-allow-credentials', 'true');
    }
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.hijack();

    // Best-effort disconnect tracking (MVP: log; generator drains naturally)
    let clientDisconnected = false;
    request.raw.on('close', () => {
      clientDisconnected = true;
      app.log.debug({ conversationId: conversation_id }, 'dashboard-agent SSE client disconnected');
    });

    try {
      const gen = runAgentTurn({
        conversationId: conversation_id,
        userId,
        jwt,
        userMessage: message,
        model,
        pool: app.controlDb,
      });

      for await (const event of gen) {
        if (clientDisconnected) break;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });
}
