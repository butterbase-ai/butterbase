/**
 * End-to-end integration tests for dashboard-agent routes.
 *
 * Gate: requires TEST_DATABASE_URL to run (describe.skipIf(!RUN)).
 *
 * External I/O mocked:
 *   - AI gateway:  global.fetch stubbed with hand-crafted OpenAI SSE deltas.
 *   - MCP client:  callMcpTool from mcp-client.ts mocked via vi.mock.
 *
 * Real (not mocked):
 *   - Fastify server booted with dashboardAgentRoutes
 *   - pg.Pool → real Postgres database
 *   - runAgentTurn loop and all store functions
 *
 * Auth: injected via app.addHook('onRequest') — same pattern as people.e2e.test.ts (line 276).
 *
 * Run:
 *   TEST_DATABASE_URL=<postgres-url> pnpm --filter control-api test dashboard-agent.e2e
 */

// Gate: skip the entire suite when no real Postgres is available.
const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = !!DB_URL;

// ── Module mocks (hoisted by Vitest before imports) ──────────────────────────
//
// We mock callMcpTool so the loop never reaches the real MCP server.
// global.fetch is mocked per-test to control gateway SSE responses.

import { vi } from 'vitest';

vi.mock('../../services/dashboard-agent/mcp-client.js', () => ({
  callMcpTool: vi.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import { dashboardAgentRoutes } from '../dashboard-agent.js';
import { callMcpTool } from '../../services/dashboard-agent/mcp-client.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal OpenAI-compatible SSE ReadableStream from delta objects.
 * Appends `data: [DONE]` automatically — matches the gateway wire format.
 */
function makeSseStream(deltas: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const body =
    deltas.map((d) => `data: ${JSON.stringify(d)}\n\n`).join('') +
    'data: [DONE]\n\n';
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

/** Wrap a delta array in a fake fetch Response with ok:true. */
function gatewayResponse(deltas: object[]): Response {
  return { ok: true, body: makeSseStream(deltas) } as unknown as Response;
}

/**
 * Build a test Fastify app with:
 *   - auth stubbed to userId (null = unauthenticated)
 *   - controlDb decorated with the real pool
 *   - dashboardAgentRoutes registered (no prefix — matches unit test convention)
 *
 * Auth-mock pattern: people.e2e.test.ts lines 275-283.
 */
async function buildApp(userId: string | null, pool: pg.Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorateRequest('auth', null as any);
  app.addHook('onRequest', async (request) => {
    (request as any).auth = {
      userId,
      authMethod: 'jwt' as const,
      scopes: ['*'],
    };
  });

  app.decorate('controlDb', pool as any);
  await app.register(dashboardAgentRoutes);
  await app.ready();
  return app;
}

/** Parse SSE frames emitted by the route (JSON objects in `data: …\n\n` lines). */
function parseSseFrames(body: string): unknown[] {
  return body
    .split('\n\n')
    .filter((segment) => segment.startsWith('data: '))
    .map((segment) => JSON.parse(segment.slice(6)));
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)('dashboard-agent e2e', () => {
  let pool: pg.Pool;

  // Randomised per-run so suites can run concurrently without row collisions.
  const USER_A = randomUUID();
  const USER_B = randomUUID();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL!, max: 5 });
    process.env.DASHBOARD_ASSISTANT_ENABLED = '1';
  }, 30_000);

  afterAll(async () => {
    delete process.env.DASHBOARD_ASSISTANT_ENABLED;
    if (pool) {
      // Messages cascade-delete with conversations, but be explicit for clarity.
      await pool.query(
        `DELETE FROM dashboard_agent_messages
         WHERE conversation_id IN (
           SELECT id FROM dashboard_agent_conversations WHERE user_id IN ($1, $2)
         )`,
        [USER_A, USER_B],
      );
      await pool.query(
        `DELETE FROM dashboard_agent_conversations WHERE user_id IN ($1, $2)`,
        [USER_A, USER_B],
      );
      await pool.end();
    }
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Case A: SSE frame ordering + DB persistence ───────────────────────────

  describe('Case A: happy path SSE frame ordering', () => {
    it(
      'streams tokens, tool_call, tool_result, then final tokens in order; persists 4 DB rows',
      async () => {
        const app = await buildApp(USER_A, pool);

        try {
          // ── Step 1: create conversation ──────────────────────────────────────
          const convR = await app.inject({
            method: 'POST',
            url: '/conversations',
            payload: { title: 'e2e-case-a', model: 'gpt-4o' },
          });
          expect(convR.statusCode).toBe(201);
          const { conversation } = convR.json<{ conversation: { id: string } }>();
          const conversationId = conversation.id;

          // ── Step 2: mock gateway — pass 1 (tokens + tool_call) ──────────────
          //   Emit: token('Hel'), token('lo'), tool_call(c1, manage_app, {action:'list'})
          const pass1 = gatewayResponse([
            { choices: [{ delta: { content: 'Hel' }, finish_reason: null }] },
            { choices: [{ delta: { content: 'lo' }, finish_reason: null }] },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'c1', function: { name: 'manage_app', arguments: '' } },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, function: { arguments: '{"action":"list"}' } }],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]);

          // ── Step 2: mock gateway — pass 2 (final tokens) ────────────────────
          const pass2 = gatewayResponse([
            { choices: [{ delta: { content: 'You have ' }, finish_reason: null }] },
            { choices: [{ delta: { content: 'no apps.' }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
          ]);

          global.fetch = vi.fn()
            .mockResolvedValueOnce(pass1)
            .mockResolvedValueOnce(pass2);

          // ── Step 3: mock MCP manage_app list → returns {apps:[]} ─────────────
          vi.mocked(callMcpTool).mockResolvedValueOnce({ ok: true, result: { apps: [] } });

          // ── Step 4: POST /messages ───────────────────────────────────────────
          const msgR = await app.inject({
            method: 'POST',
            url: '/messages',
            payload: { conversation_id: conversationId, message: 'do i have apps', model: 'gpt-4o' },
            headers: { authorization: 'Bearer test-jwt' },
          });

          expect(msgR.statusCode).toBe(200);
          expect(msgR.headers['content-type']).toContain('text/event-stream');

          // ── Step 5/6: assert EXACT frame order ───────────────────────────────
          const frames = parseSseFrames(msgR.body);

          expect(frames).toHaveLength(8);
          expect(frames[0]).toMatchObject({ type: 'token', text: 'Hel' });
          expect(frames[1]).toMatchObject({ type: 'token', text: 'lo' });
          expect(frames[2]).toMatchObject({ type: 'tool_call', id: 'c1', name: 'manage_app' });
          expect(frames[3]).toMatchObject({ type: 'tool_result', id: 'c1' });
          expect(frames[4]).toMatchObject({ type: 'token', text: 'You have ' });
          expect(frames[5]).toMatchObject({ type: 'token', text: 'no apps.' });
          expect(frames[6]).toMatchObject({ type: 'assistant_message', content: 'You have no apps.' });
          expect(frames[7]).toMatchObject({ type: 'done' });

          // ── Step 7: verify Postgres rows ─────────────────────────────────────
          type MsgRow = { role: string; content: string; tool_call_id: string | null; tool_result: unknown };
          const { rows } = await pool.query<MsgRow>(
            `SELECT role, content, tool_call_id, tool_result
             FROM dashboard_agent_messages
             WHERE conversation_id = $1
             ORDER BY created_at ASC`,
            [conversationId],
          );

          // Expect exactly 4 rows: user, assistant+toolCall, tool result, final assistant
          expect(rows).toHaveLength(4);

          // Row 1: user message
          expect(rows[0].role).toBe('user');
          expect(rows[0].content).toBe('do i have apps');
          expect(rows[0].tool_call_id).toBeNull();

          // Row 2: assistant row with toolCallId='c1'
          expect(rows[1].role).toBe('assistant');
          expect(rows[1].tool_call_id).toBe('c1');

          // Row 3: tool row with toolCallId='c1' and non-null toolResult
          expect(rows[2].role).toBe('tool');
          expect(rows[2].tool_call_id).toBe('c1');
          expect(rows[2].tool_result).toBeTruthy();

          // Row 4: final assistant row with content, no toolCallId
          expect(rows[3].role).toBe('assistant');
          expect(rows[3].content).toBe('You have no apps.');
          expect(rows[3].tool_call_id).toBeNull();
        } finally {
          await app.close();
        }
      },
      30_000,
    );
  });

  // ── Case B: cross-tenant ownership ────────────────────────────────────────

  describe('Case B: cross-tenant ownership', () => {
    it(
      'returns 404 for all cross-user operations; original conversation survives',
      async () => {
        const appA = await buildApp(USER_A, pool);
        const appB = await buildApp(USER_B, pool);

        try {
          // Step 1: USER_A creates conversation
          const convR = await appA.inject({
            method: 'POST',
            url: '/conversations',
            payload: { title: 'e2e-case-b', model: 'gpt-4o' },
          });
          expect(convR.statusCode).toBe(201);
          const { conversation } = convR.json<{ conversation: { id: string } }>();
          const convA = conversation.id;

          // Step 2: USER_A posts one message (mock a simple no-tool-call pass)
          global.fetch = vi.fn().mockResolvedValueOnce(
            gatewayResponse([
              { choices: [{ delta: { content: 'Hi there.' }, finish_reason: null }] },
              { choices: [{ delta: {}, finish_reason: 'stop' }] },
            ]),
          );

          const msgA = await appA.inject({
            method: 'POST',
            url: '/messages',
            payload: { conversation_id: convA, message: 'hi', model: 'gpt-4o' },
            headers: { authorization: 'Bearer test-jwt-a' },
          });
          expect(msgA.statusCode).toBe(200);

          // Step 3a: USER_B GET /conversations/{conv_a} → 404
          const getR = await appB.inject({
            method: 'GET',
            url: `/conversations/${convA}`,
          });
          expect(getR.statusCode).toBe(404);
          expect(getR.json()).toMatchObject({ error: 'conversation not found' });

          // Step 3b: USER_B DELETE /conversations/{conv_a} → 404 (no-op)
          const delR = await appB.inject({
            method: 'DELETE',
            url: `/conversations/${convA}`,
          });
          expect(delR.statusCode).toBe(404);

          // Step 3c: USER_B POST /messages {conversation_id: convA} → 404
          //          Must be JSON (ownership check fires BEFORE reply.hijack())
          const msgB = await appB.inject({
            method: 'POST',
            url: '/messages',
            payload: { conversation_id: convA, message: 'hi', model: 'gpt-4o' },
            headers: { authorization: 'Bearer test-jwt-b' },
          });
          expect(msgB.statusCode).toBe(404);
          expect(msgB.headers['content-type']).not.toContain('text/event-stream');
          expect(msgB.json()).toMatchObject({ error: 'conversation not found' });

          // Step 4: USER_A can still access their conversation (DELETE was a no-op)
          const ownR = await appA.inject({
            method: 'GET',
            url: `/conversations/${convA}`,
          });
          expect(ownR.statusCode).toBe(200);
        } finally {
          await appA.close();
          await appB.close();
        }
      },
      30_000,
    );
  });

  // ── Case C: feature flag off ───────────────────────────────────────────────

  describe('Case C: feature flag off', () => {
    it(
      'returns 404 on every endpoint when DASHBOARD_ASSISTANT_ENABLED is unset; unauthenticated caller gets 404 not 401',
      async () => {
        // Temporarily unset the flag — restoring in finally so other tests are unaffected.
        delete process.env.DASHBOARD_ASSISTANT_ENABLED;

        // null userId = unauthenticated; flag check must fire before requireUserId
        const app = await buildApp(null, pool);

        try {
          const endpoints: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string }> = [
            { method: 'POST', url: '/conversations' },
            { method: 'GET', url: '/conversations' },
            { method: 'GET', url: '/conversations/some-id' },
            { method: 'DELETE', url: '/conversations/some-id' },
            { method: 'POST', url: '/messages' },
          ];

          for (const { method, url } of endpoints) {
            const r = await app.inject({ method, url, payload: {} });
            expect(r.statusCode, `${method} ${url} should be 404 when flag is off`).toBe(404);
            expect(r.json()).toMatchObject({ error: 'not enabled' });
          }
        } finally {
          await app.close();
          // Restore flag so subsequent tests in this suite see it as enabled.
          process.env.DASHBOARD_ASSISTANT_ENABLED = '1';
        }
      },
      30_000,
    );
  });
});
