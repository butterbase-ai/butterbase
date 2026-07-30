/**
 * Dashboard Assistant HTTP routes.
 *
 * Endpoints:
 *   POST   /conversations          – create a conversation
 *   GET    /conversations          – list caller's conversations
 *   GET    /conversations/:id      – get conversation + messages
 *   DELETE /conversations/:id      – delete conversation (204)
 *   PATCH  /conversations/:id/rename    – rename conversation (user-chosen title)
 *   POST   /conversations/:id/duplicate – copy conversation + all messages
 *   POST   /conversations/:id/pin       – set/clear pinned_at
 *   POST   /messages               – SSE agent turn (streams LoopEvent frames)
 *   POST   /conversations/:id/regenerate – regenerate an assistant reply, or
 *          edit-and-resend a user message ({message_id, new_user_message?}).
 *          Deletes the target message + everything after it, then streams a
 *          fresh turn via SSE (same wire format as /messages).
 *   POST   /messages/:id/rate      – set/clear a thumbs up/down + optional
 *          reason on an assistant message ({rating: 1|-1|0, reason?}).
 *   POST   /conversations/:id/rewind – restore working tree to a prior snapshot
 *   GET    /conversations/:id/snapshots – list snapshot history + labels
 *   POST   /conversations/:id/snapshots/label – set a user label on a snapshot
 *   POST   /v1/dashboard-agent/approvals/:id/resolve – approve/deny a gated
 *          tool call and stream the resumed turn's SSE events. Combines the
 *          approve/deny + resume-and-execute steps described in the Plan 3b
 *          Task 3 brief into a single endpoint (documented choice — see brief
 *          "For simplicity ... pick and document").
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
  renameConversation,
  duplicateConversation,
  pinConversation,
  listMessages,
  appendMessage,
  listSnapshotLabels,
  upsertSnapshotLabel,
  getMessageById,
  deleteMessagesFromInclusive,
  getLastUserMessage,
  getMessageWithOwner,
  rateMessage,
  type SnapshotLabel,
} from '../services/dashboard-agent/store.js';
import { runAgentTurn, getSharedWorkingTreeCache } from '../services/dashboard-agent/loop.js';
import { publish as publishEvent, subscribe as subscribeToConversation } from '../services/dashboard-agent/event-bus.js';
import { getRecentAppIds } from '../services/dashboard-agent/schema-context.js';
import { listUsage, getConversationUsageTotal } from '../services/dashboard-agent/usage-store.js';
import { createRepoSync } from '../services/dashboard-agent/repo-sync.js';
import { callMcpTool } from '../services/dashboard-agent/mcp-client.js';
import { resolveApprovalAndPersistResult } from '../services/dashboard-agent/resume.js';

// ---------------------------------------------------------------------------
// Feature-flag guard
// ---------------------------------------------------------------------------

function isEnabled(): boolean {
  return process.env.DASHBOARD_ASSISTANT_ENABLED === '1';
}

// ---------------------------------------------------------------------------
// Helper: calculate usage cost (Plan 3e Task 16)
// ---------------------------------------------------------------------------

function calculateUsageCost(promptTokens: number, completionTokens: number): number {
  // Approximate cost based on Haiku (cheapest) pricing
  // Real deployment would query stored cost or use model-specific pricing
  // Haiku: $0.80/$4 per 1M, but default to conservative mid-range estimate
  const promptPricePerMillion = 3.0;
  const completionPricePerMillion = 15.0;
  const promptCost = (promptTokens / 1_000_000) * promptPricePerMillion;
  const completionCost = (completionTokens / 1_000_000) * completionPricePerMillion;
  return parseFloat((promptCost + completionCost).toFixed(6));
}

// ---------------------------------------------------------------------------
// MCP wrapper + repoSync for the rewind route.
//
// Mirrors defaultMcp()/getDefaultDeps() in loop.ts (not exported from there),
// but shares the SAME cache instance via getSharedWorkingTreeCache() so a
// rewind's pullSnapshot()/pushCurrentTree() operate on the same in-memory
// working tree that runAgentTurn reads/writes.
//
// Built lazily (not at module scope) so unit tests that vi.mock loop.js with
// a partial mock (only runAgentTurn) don't blow up trying to resolve
// getSharedWorkingTreeCache() at import time.
// ---------------------------------------------------------------------------

const rewindMcp = {
  async call(name: string, args: unknown, jwt: string) {
    const r = await callMcpTool(name, args, jwt);
    if (!r.ok) throw new Error(r.error ?? 'mcp call failed');
    return r.result;
  },
};

function getRewindRepoSync() {
  return createRepoSync({ cache: getSharedWorkingTreeCache(), mcp: rewindMcp });
}

// ---------------------------------------------------------------------------
// Snapshot list + label merge (used by GET /conversations/:id/snapshots).
//
// Exported standalone so it can be unit-tested without booting Fastify or
// mocking the MCP client — see dashboard-agent.e2e.test.ts.
// ---------------------------------------------------------------------------

export type RawSnapshot = {
  snapshot_id?: string;
  snapshotId?: string;
  message?: string | null;
  files_count?: number | null;
  filesCount?: number | null;
  created_at?: string;
  createdAt?: string;
};

export type MergedSnapshot = {
  id: string;
  message: string | null;
  files_count: number | null;
  created_at: string;
  label: string | null;
  auto_generated_label: boolean;
};

export function mergeSnapshotsWithLabels(
  rawSnapshots: RawSnapshot[],
  labels: SnapshotLabel[]
): MergedSnapshot[] {
  const labelBySnapshotId = new Map(labels.map((l) => [l.snapshotId, l]));

  const merged = rawSnapshots.map((s) => {
    const id = s.snapshot_id ?? s.snapshotId ?? '';
    const label = labelBySnapshotId.get(id) ?? null;
    return {
      id,
      message: s.message ?? null,
      files_count: s.files_count ?? s.filesCount ?? null,
      created_at: s.created_at ?? s.createdAt ?? '',
      label: label ? label.label : null,
      auto_generated_label: label ? label.autoGenerated : false,
    };
  });

  // Sort newest-first.
  merged.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  return merged;
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

const rewindBody = z.object({
  app_id: z.string().min(1),
  snapshot_id: z.string().min(1),
});

const labelSnapshotBody = z.object({
  app_id: z.string().min(1),
  snapshot_id: z.string().min(1),
  label: z.string().min(1).max(200),
});

const resolveApprovalBody = z
  .object({
    status: z.enum(['approved', 'denied']),
    trust_scope: z.enum(['conversation']).optional(),
    reason: z.string().max(2000).optional(),
  })
  .strict();

const renameConversationBody = z.object({
  title: z.string().trim().min(1).max(200),
});

const pinConversationBody = z.object({
  pinned: z.boolean(),
});

const regenerateBody = z.object({
  message_id: z.string().uuid(),
  new_user_message: z.string().min(1).optional(),
});

// rating: 1 (thumbs up) | -1 (thumbs down) | 0 (un-rate — clears both
// rating + rating_reason). `reason` is only meaningful alongside rating: -1;
// the store silently drops it otherwise (documented in rateMessage's jsdoc).
const rateMessageBody = z.object({
  rating: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  reason: z.string().max(2000).optional(),
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

  // ── PATCH /conversations/:id/rename — user-chosen title ─────────────────
  app.patch('/conversations/:id/rename', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const parsed = renameConversationBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const updated = await renameConversation(app.controlDb, id, userId, parsed.data.title);
    if (!updated) return reply.code(404).send({ error: 'conversation not found' });
    return reply.send({ conversation: updated });
  });

  // ── POST /conversations/:id/duplicate — copy conversation + messages ────
  app.post('/conversations/:id/duplicate', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    // Ownership check up front so a bad id 404s without touching the store's
    // transaction (duplicateConversation throws for the same case, but this
    // gives an early, cheap, consistent 404 path with the rest of the file).
    const conversation = await getConversation(app.controlDb, id, userId);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    const duplicate = await duplicateConversation(app.controlDb, id, userId);
    return reply.code(201).send({ conversation: duplicate });
  });

  // ── POST /conversations/:id/pin — set/clear pinned_at ────────────────────
  app.post('/conversations/:id/pin', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const parsed = pinConversationBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const updated = await pinConversation(app.controlDb, id, userId, parsed.data.pinned);
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
        publishEvent(conversation_id, event);
        if (clientDisconnected) continue;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errEvent = { type: 'error' as const, message: msg };
      publishEvent(conversation_id, errEvent);
      if (!clientDisconnected) reply.raw.write(`data: ${JSON.stringify(errEvent)}\n\n`);
    } finally {
      reply.raw.end();
    }
  });

  // ── GET /conversations/:id/stream ────────────────────────────────────────
  // Persistent SSE — subscribes to the in-process event bus so any running
  // turn's events flow into this connection, even without holding the
  // original POST /messages open. Heartbeat every 25s keeps proxies happy.
  app.get('/conversations/:id/stream', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });
    const userId = requireUserId(request);
    const { id } = request.params as { id: string };
    const conversation = await getConversation(app.controlDb, id, userId);
    if (!conversation) return reply.code(404).send({ error: 'conversation not found' });

    // reply.hijack() bypasses Fastify's onSend (where @fastify/cors normally
    // injects CORS headers), so reflect the caller Origin explicitly.
    const requestOrigin = request.headers.origin;
    if (requestOrigin) {
      reply.raw.setHeader('access-control-allow-origin', requestOrigin);
      reply.raw.setHeader('vary', 'origin');
      reply.raw.setHeader('access-control-allow-credentials', 'true');
    }
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.setHeader('x-accel-buffering', 'no');
    reply.hijack();

    let disconnected = false;
    const unsubscribe = subscribeToConversation(id, (evt) => {
      if (disconnected) return;
      try { reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { /* noop */ }
    });
    const heartbeat = setInterval(() => {
      if (disconnected) return;
      try { reply.raw.write(`: ping\n\n`); } catch { /* noop */ }
    }, 25_000);
    try { reply.raw.write(`: subscribed\n\n`); } catch { /* noop */ }

    request.raw.on('close', () => {
      disconnected = true;
      clearInterval(heartbeat);
      unsubscribe();
      try { reply.raw.end(); } catch { /* noop */ }
    });
  });

  // ── POST /messages/:id/rate — thumbs up/down + optional reason (Task 19) ─
  app.post('/messages/:id/rate', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const parsed = rateMessageBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    // Ownership check via conversation_id → user_id join — 404 for both a
    // nonexistent message and a message that belongs to another user's
    // conversation (no distinction leaked to the caller).
    const message = await getMessageWithOwner(app.controlDb, id, userId);
    if (!message) {
      return reply.code(404).send({ error: 'message not found' });
    }
    if (message.role !== 'assistant') {
      return reply.code(400).send({ error: 'only assistant messages can be rated' });
    }

    await rateMessage(app.controlDb, id, parsed.data.rating, parsed.data.reason);

    const updated = await getMessageWithOwner(app.controlDb, id, userId);
    return reply.send({ message: updated });
  });

  // ── POST /conversations/:id/regenerate ───────────────────────────────────
  //
  // Two-in-one endpoint (Plan 3e Task 6):
  //   - Regenerate: {message_id} only. message_id MUST reference an
  //     'assistant' row. Deletes that row + everything after it, then
  //     replays the last remaining user message.
  //   - Edit-and-resend: {message_id, new_user_message}. message_id MUST
  //     reference a 'user' row. Deletes that row + everything after it, then
  //     runs new_user_message as the next user turn.
  // Streams the resulting turn via SSE, same wire format as /messages.
  app.post('/conversations/:id/regenerate', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const parsed = regenerateBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { message_id: messageId, new_user_message: newUserMessage } = parsed.data;

    // Ownership check BEFORE sending SSE headers — once headers are sent we
    // cannot return a JSON 404/400.
    const conversation = await getConversation(app.controlDb, id, userId);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    const target = await getMessageById(app.controlDb, id, messageId);
    if (!target) {
      return reply.code(404).send({ error: 'message not found' });
    }

    let userMessageToReplay: string;

    if (newUserMessage != null) {
      // Edit-and-resend: message_id must be a user row.
      if (target.role !== 'user') {
        return reply.code(400).send({ error: 'new_user_message requires message_id to reference a user message' });
      }
      await deleteMessagesFromInclusive(app.controlDb, id, messageId);
      userMessageToReplay = newUserMessage;
    } else {
      // Regenerate: message_id must be an assistant row.
      if (target.role !== 'assistant') {
        return reply.code(400).send({ error: 'message_id must reference an assistant message to regenerate' });
      }
      await deleteMessagesFromInclusive(app.controlDb, id, messageId);
      const lastUser = await getLastUserMessage(app.controlDb, id);
      if (!lastUser) {
        return reply.code(400).send({ error: 'no user message to regenerate from' });
      }
      userMessageToReplay = lastUser.content;
    }

    // Extract JWT verbatim from Authorization header, same as /messages.
    const authHeader = request.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // Begin SSE response — mirrors /messages.
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

    let clientDisconnected = false;
    request.raw.on('close', () => {
      clientDisconnected = true;
      app.log.debug({ conversationId: id }, 'dashboard-agent regenerate SSE client disconnected');
    });

    try {
      const gen = runAgentTurn({
        conversationId: id,
        userId,
        jwt,
        userMessage: userMessageToReplay,
        model: conversation.model,
        pool: app.controlDb,
      });

      for await (const event of gen) {
        publishEvent(id, event);
        if (clientDisconnected) continue;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errEvent = { type: 'error' as const, message: msg };
      publishEvent(id, errEvent);
      if (!clientDisconnected) reply.raw.write(`data: ${JSON.stringify(errEvent)}\n\n`);
    } finally {
      reply.raw.end();
    }
  });

  // ── POST /conversations/:id/rewind ───────────────────────────────────────
  //
  // Restores the conversation's working-tree cache to an earlier snapshot's
  // state, then pushes that state back out as a brand-new snapshot (history
  // is append-only — we never delete or rewrite existing snapshots). Returns
  // a plain JSON summary rather than SSE; the frontend refetches conversation
  // state afterwards to pick up the new assistant message + latest files.
  app.post('/conversations/:id/rewind', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const parsed = rewindBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { app_id: appId, snapshot_id: snapshotId } = parsed.data;

    // 1. Ownership check.
    const conversation = await getConversation(app.controlDb, id, userId);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    // Extract JWT verbatim from Authorization header, same as /messages.
    const authHeader = request.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // 2. Loose guard: app_id must have shown up in this conversation's
    // tool_args at least once. Best-effort — if the lookup itself throws we
    // don't block the rewind on it (schema/store hiccups shouldn't brick the
    // feature), but if it succeeds and the app_id truly never appeared, reject.
    try {
      const recentAppIds = await getRecentAppIds(app.controlDb, id);
      if (recentAppIds.length > 0 && !recentAppIds.includes(appId)) {
        return reply.code(400).send({ error: 'app_id not associated with this conversation' });
      }
    } catch {
      // best-effort guard only
    }

    // 3. Validate snapshot_id is a real snapshot of this app before touching
    // the cache — avoids clobbering the working tree on a typo'd snapshot_id.
    try {
      const raw: any = await rewindMcp.call('manage_repo', { action: 'list_snapshots', app_id: appId }, jwt);
      let payload: any = raw;
      if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
        const textFrame = raw.content.find((c: any) => c?.type === 'text' && typeof c.text === 'string');
        if (textFrame) { try { payload = JSON.parse(textFrame.text); } catch { payload = {}; } }
      }
      const snapshots: Array<{ snapshot_id?: string; snapshotId?: string }> = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.snapshots) ? payload.snapshots : [];
      const ids = snapshots.map((s) => s.snapshot_id ?? s.snapshotId).filter(Boolean);
      if (ids.length > 0 && !ids.includes(snapshotId)) {
        return reply.code(400).send({ error: 'snapshot_id not found for this app' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `failed to list snapshots: ${msg}` });
    }

    const repoSync = getRewindRepoSync();

    // 4. Pull the target snapshot — overwrites the shared cache for (id, appId).
    let filesChanged = 0;
    try {
      const pulled = await repoSync.pullSnapshot({ convId: id, appId, snapshotId, jwt });
      if (!pulled.hydrated) {
        return reply.code(400).send({ error: 'snapshot has no files or could not be hydrated' });
      }
      filesChanged = getSharedWorkingTreeCache().list(id, appId).length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `pull_snapshot failed: ${msg}` });
    }

    // 5. Push the (now-restored) cache back out as a new, append-only snapshot.
    let newSnapshotId: string | null = null;
    try {
      const pushed = await repoSync.pushCurrentTree({ convId: id, appId, jwt });
      newSnapshotId = pushed.snapshotId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `push failed: ${msg}` });
    }

    // 6. Record the rewind as an assistant message.
    await appendMessage(app.controlDb, id, {
      role: 'assistant',
      content: `Rewound to snapshot ${snapshotId}. Working tree restored.`,
      toolCallId: null,
      toolName: null,
      toolArgs: null,
      toolResult: null,
      modelUsed: null,
    });

    return reply.send({ new_snapshot_id: newSnapshotId, files_changed: filesChanged });
  });

  // ── GET /conversations/:id/apps/:app_id/tree ─────────────────────────────
  //
  // Read-only helper: hydrates a browsable file list for an app whose repo
  // exists server-side but which the current conversation has not touched
  // (e.g. the pane's App Directory picked it). Peels the MCP envelope, fetches
  // each blob's content, returns { files: [{ path, content, sha256 }] }.
  // Ownership on the conversation is checked; app-level ACL is enforced by
  // the underlying manage_repo tool.
  app.get('/conversations/:id/apps/:app_id/tree', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });
    const userId = requireUserId(request);
    const { id, app_id: appId } = request.params as { id: string; app_id: string };

    const conversation = await getConversation(app.controlDb, id, userId);
    if (!conversation) return reply.code(404).send({ error: 'conversation not found' });

    const authHeader = request.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    let payload: any;
    try {
      const raw: any = await rewindMcp.call('manage_repo', { action: 'pull_latest', app_id: appId }, jwt);
      payload = raw;
      if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
        const textFrame = raw.content.find((c: any) => c?.type === 'text' && typeof c.text === 'string');
        if (textFrame) { try { payload = JSON.parse(textFrame.text); } catch { payload = {}; } }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 404 vs 500: pull_latest returns "no snapshot yet" as a specific error;
      // treat any failure here as empty rather than 500 so the client can render
      // "No files" instead of surfacing an obscure MCP error.
      request.log.warn({ err: msg, appId }, 'tree hydrate: pull_latest failed');
      return reply.send({ files: [] });
    }

    const files: Array<{ path: string; sha256: string; downloadUrl?: string; download_url?: string }> = payload?.files ?? [];
    if (files.length === 0) return reply.send({ files: [] });

    const out = await Promise.all(files.map(async (f) => {
      const url = f.downloadUrl ?? f.download_url;
      if (!url) return null;
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const content = await resp.text();
        return { path: f.path, sha256: f.sha256, content };
      } catch { return null; }
    }));

    return reply.send({ files: out.filter((f): f is { path: string; sha256: string; content: string } => f !== null) });
  });

  // ── GET /conversations/:id/snapshots ─────────────────────────────────────
  //
  // Lists snapshot history for an app associated with this conversation,
  // left-joined with any user/auto labels recorded for (conversation, app,
  // snapshot). Sorted newest-first; labeled entries are NOT pinned to the
  // top here — that's a client-side (Plan 3d T6) concern.
  app.get('/conversations/:id/snapshots', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };
    const q = (request.query ?? {}) as { app_id?: string };
    const appId = q.app_id;

    // 1. Ownership check.
    const conversation = await getConversation(app.controlDb, id, userId);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    // 2. Validate app_id query param.
    if (!appId) {
      return reply.code(400).send({ error: 'app_id query param is required' });
    }

    // 3. Read-only route: no per-conversation association guard. The
    // underlying MCP tool (manage_repo.list_snapshots) enforces app ownership,
    // and the pane's app-directory picker lets users browse any app in their
    // active org — a stricter conversation-scoped guard here would 404 that UX.

    // Extract JWT verbatim from Authorization header, same as /messages and /rewind.
    const authHeader = request.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // 4. Fetch raw snapshot list from manage_repo. MCP tools return either the
    // raw payload OR an envelope { content: [{ type: 'text', text: '<json>' }] };
    // peel that here so mergeSnapshotsWithLabels always sees an array.
    let rawSnapshots: RawSnapshot[] = [];
    try {
      const raw: any = await rewindMcp.call('manage_repo', { action: 'list_snapshots', app_id: appId }, jwt);
      let payload: any = raw;
      if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
        const textFrame = raw.content.find((c: any) => c?.type === 'text' && typeof c.text === 'string');
        if (textFrame) {
          try { payload = JSON.parse(textFrame.text); } catch { payload = {}; }
        }
      }
      const listSnapshots = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.snapshots) ? payload.snapshots : [];
      rawSnapshots = listSnapshots as RawSnapshot[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `failed to list snapshots: ${msg}` });
    }

    // 5. Left-join with dashboard_agent_snapshot_labels for this (conv, app).
    const labels = await listSnapshotLabels(app.controlDb, id, appId);

    // 6. Merge + sort newest-first.
    const snapshots = mergeSnapshotsWithLabels(rawSnapshots, labels);

    return reply.send({ snapshots });
  });

  // ── POST /conversations/:id/snapshots/label ──────────────────────────────
  //
  // Records/overwrites a user-supplied label for a (conversation, app,
  // snapshot) triple. Same ownership + loose app_id-association guards as
  // the other snapshot routes.
  app.post('/conversations/:id/snapshots/label', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const parsed = labelSnapshotBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { app_id: appId, snapshot_id: snapshotId, label } = parsed.data;

    // 1. Ownership check.
    const conversation = await getConversation(app.controlDb, id, userId);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    // 2. Loose guard: app_id must have shown up in this conversation's
    // tool_args at least once (same best-effort pattern as rewind/snapshots).
    try {
      const recentAppIds = await getRecentAppIds(app.controlDb, id);
      if (recentAppIds.length > 0 && !recentAppIds.includes(appId)) {
        return reply.code(404).send({ error: 'app_id not associated with this conversation' });
      }
    } catch {
      // best-effort guard only
    }

    await upsertSnapshotLabel(app.controlDb, {
      conversationId: id,
      appId,
      snapshotId,
      label,
      autoGenerated: false,
    });

    return reply.send({ ok: true });
  });

  // ── GET /conversations/:id/usage-total ───────────────────────────────────
  // Sum all tokens and compute total cost for a conversation (Plan 3e Task 16)
  app.get('/conversations/:id/usage-total', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    // Ownership check
    const conversation = await getConversation(app.controlDb, id, userId);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    const { promptTokens, completionTokens } = await getConversationUsageTotal(
      app.controlDb,
      id,
    );

    // Calculate cost using the helper from ai-usage-logger
    // For now use a simplified approach: average cost across common models
    // Real: fetch stored cost if available, else compute from tokens
    const totalCostUsd = calculateUsageCost(promptTokens, completionTokens);

    return reply.send({
      total_cost_usd: totalCostUsd,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    });
  });

  // ── GET /usage ────────────────────────────────────────
  app.get('/usage', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const q = (request.query ?? {}) as { user_id?: string; conversation_id?: string };

    // V1: users only see their own rows (no admin gate yet).
    const filterUserId = q.user_id ?? userId;
    if (filterUserId !== userId) return reply.code(403).send({ error: 'forbidden' });

    const rows = await listUsage(app.controlDb, {
      userId: filterUserId,
      conversationId: q.conversation_id,
    });

    return reply.send({ rows });
  });

  // ── POST /approvals/:id/resolve ───────────────────────
  //
  // Approve or deny a gated tool call (Plan 3b Task 2's approval_required
  // pause), then stream the resumed turn's SSE events. See resume.ts for the
  // execute-then-persist steps that make the resumed history valid before
  // the agent loop is re-entered.
  app.post('/approvals/:id/resolve', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id: approvalId } = request.params as { id: string };

    const parsed = resolveApprovalBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { status, trust_scope: trustScope, reason } = parsed.data;

    // Extract JWT verbatim from Authorization header, same as /messages.
    const authHeader = request.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // Ownership + status checks, tool execution/denial-synthesis, and the
    // follow-up tool-result row are all done BEFORE any SSE headers are
    // sent — once hijacked we can't return a JSON 404/409/400.
    const outcome = await resolveApprovalAndPersistResult(app.controlDb, {
      approvalId,
      userId,
      jwt,
      resolution:
        status === 'approved' ? { status: 'approved', trustScope } : { status: 'denied', reason },
    });

    if (!outcome.ok) {
      return reply.code(outcome.code).send({ error: outcome.error });
    }

    const conversationId = outcome.approval.conversationId;

    // Begin SSE response — mirrors /messages.
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

    let clientDisconnected = false;
    request.raw.on('close', () => {
      clientDisconnected = true;
      app.log.debug({ conversationId }, 'dashboard-agent resume SSE client disconnected');
    });

    try {
      const conversation = await getConversation(app.controlDb, conversationId, userId);
      const model = conversation?.model ?? 'claude-sonnet-4-5';

      // Empty userMessage: the resumed turn's history already contains the
      // just-persisted tool-result row (via resolveApprovalAndPersistResult).
      // The loop still appends a `role: 'user'` row per turn — an empty one
      // here is a harmless no-op line in history, not a duplicate prompt.
      const gen = runAgentTurn({
        conversationId,
        userId,
        jwt,
        userMessage: '',
        model,
        pool: app.controlDb,
      });

      for await (const event of gen) {
        publishEvent(conversationId, event);
        if (clientDisconnected) continue;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errEvent = { type: 'error' as const, message: msg };
      publishEvent(conversationId, errEvent);
      if (!clientDisconnected) reply.raw.write(`data: ${JSON.stringify(errEvent)}\n\n`);
    } finally {
      reply.raw.end();
    }
  });
}
