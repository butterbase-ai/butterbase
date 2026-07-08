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

  // ── Case D: rewind endpoint ────────────────────────────────────────────────

  describe('Case D: rewind endpoint', () => {
    const APP_ID = 'app_rewind_test';

    /** Queue the three MCP calls a successful rewind makes, in order. */
    function mockRewindMcpCalls(opts: {
      snapshots: string[];
      pullFiles: Array<{ path: string; sha256: string; download_url: string }>;
      pullSnapshotId: string;
      pushSnapshotId: string;
    }) {
      vi.mocked(callMcpTool)
        // 1. list_snapshots
        .mockResolvedValueOnce({
          ok: true,
          result: { snapshots: opts.snapshots.map((id) => ({ snapshot_id: id, created_at: new Date().toISOString() })) },
        })
        // 2. pull_snapshot
        .mockResolvedValueOnce({
          ok: true,
          result: { snapshot_id: opts.pullSnapshotId, files: opts.pullFiles },
        })
        // 3. push
        .mockResolvedValueOnce({
          ok: true,
          result: { snapshot_id: opts.pushSnapshotId, total_bytes: 1, file_count: opts.pullFiles.length },
        });
    }

    it(
      'requires ownership: user B rewinding user A conversation gets 404',
      async () => {
        const appA = await buildApp(USER_A, pool);
        const appB = await buildApp(USER_B, pool);

        try {
          const convR = await appA.inject({
            method: 'POST',
            url: '/conversations',
            payload: { title: 'e2e-case-d-ownership', model: 'gpt-4o' },
          });
          expect(convR.statusCode).toBe(201);
          const { conversation } = convR.json<{ conversation: { id: string } }>();

          const rewindR = await appB.inject({
            method: 'POST',
            url: `/conversations/${conversation.id}/rewind`,
            payload: { app_id: APP_ID, snapshot_id: 'snap_1' },
            headers: { authorization: 'Bearer test-jwt-b' },
          });

          expect(rewindR.statusCode).toBe(404);
          expect(rewindR.json()).toMatchObject({ error: 'conversation not found' });
          // No MCP calls should have been made — ownership check fires first.
          expect(callMcpTool).not.toHaveBeenCalled();
        } finally {
          await appA.close();
          await appB.close();
        }
      },
      30_000,
    );

    it(
      'rewinds to a valid snapshot: writes an assistant row and returns new_snapshot_id',
      async () => {
        const app = await buildApp(USER_A, pool);

        try {
          const convR = await app.inject({
            method: 'POST',
            url: '/conversations',
            payload: { title: 'e2e-case-d-happy', model: 'gpt-4o' },
          });
          expect(convR.statusCode).toBe(201);
          const { conversation } = convR.json<{ conversation: { id: string } }>();

          const originalFetch = global.fetch;
          global.fetch = vi.fn().mockResolvedValue(new Response('const x = 1;'));

          mockRewindMcpCalls({
            snapshots: ['snap_1', 'snap_2'],
            pullFiles: [
              { path: 'src/App.tsx', sha256: 'a'.repeat(64), download_url: 'https://s3/a' },
            ],
            pullSnapshotId: 'snap_1',
            pushSnapshotId: 'snap_3',
          });

          try {
            const rewindR = await app.inject({
              method: 'POST',
              url: `/conversations/${conversation.id}/rewind`,
              payload: { app_id: APP_ID, snapshot_id: 'snap_1' },
              headers: { authorization: 'Bearer test-jwt-a' },
            });

            expect(rewindR.statusCode).toBe(200);
            expect(rewindR.json()).toMatchObject({ new_snapshot_id: 'snap_3', files_changed: 1 });

            // callMcpTool called 3x: list_snapshots, pull_snapshot, push
            expect(callMcpTool).toHaveBeenCalledTimes(3);
            expect(vi.mocked(callMcpTool).mock.calls[0][0]).toBe('manage_repo');
            expect((vi.mocked(callMcpTool).mock.calls[0][1] as any).action).toBe('list_snapshots');
            expect((vi.mocked(callMcpTool).mock.calls[1][1] as any).action).toBe('pull_snapshot');
            expect((vi.mocked(callMcpTool).mock.calls[2][1] as any).action).toBe('push');

            // Assistant row persisted recording the rewind.
            type MsgRow = { role: string; content: string; model_used: string | null };
            const { rows } = await pool.query<MsgRow>(
              `SELECT role, content, model_used
               FROM dashboard_agent_messages
               WHERE conversation_id = $1
               ORDER BY created_at ASC`,
              [conversation.id],
            );
            expect(rows).toHaveLength(1);
            expect(rows[0].role).toBe('assistant');
            expect(rows[0].content).toBe('Rewound to snapshot snap_1. Working tree restored.');
            expect(rows[0].model_used).toBeNull();
          } finally {
            global.fetch = originalFetch;
          }
        } finally {
          await app.close();
        }
      },
      30_000,
    );

    it(
      'rejects rewind to a snapshot_id not in the app history with a 4xx and no DB write',
      async () => {
        const app = await buildApp(USER_A, pool);

        try {
          const convR = await app.inject({
            method: 'POST',
            url: '/conversations',
            payload: { title: 'e2e-case-d-invalid', model: 'gpt-4o' },
          });
          expect(convR.statusCode).toBe(201);
          const { conversation } = convR.json<{ conversation: { id: string } }>();

          // Only list_snapshots is mocked — snap_999 is not among the returned ids,
          // so the route should reject before ever calling pull_snapshot/push.
          vi.mocked(callMcpTool).mockResolvedValueOnce({
            ok: true,
            result: { snapshots: [{ snapshot_id: 'snap_1', created_at: new Date().toISOString() }] },
          });

          const rewindR = await app.inject({
            method: 'POST',
            url: `/conversations/${conversation.id}/rewind`,
            payload: { app_id: APP_ID, snapshot_id: 'snap_999' },
            headers: { authorization: 'Bearer test-jwt-a' },
          });

          expect(rewindR.statusCode).toBeGreaterThanOrEqual(400);
          expect(rewindR.statusCode).toBeLessThan(500);
          expect(callMcpTool).toHaveBeenCalledTimes(1); // only list_snapshots

          const { rows } = await pool.query(
            `SELECT id FROM dashboard_agent_messages WHERE conversation_id = $1`,
            [conversation.id],
          );
          expect(rows).toHaveLength(0);
        } finally {
          await app.close();
        }
      },
      30_000,
    );
  });
});
