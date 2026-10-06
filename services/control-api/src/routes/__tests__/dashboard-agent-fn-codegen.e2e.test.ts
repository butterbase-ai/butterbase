/**
 * E2E smoke test for the full function-codegen flow (Plan 3c Task 6).
 *
 * Drives one assistant turn that emits THREE tool_calls in a single gateway
 * pass — two `write_file` calls (function source + package.json) followed by
 * one `deploy_function_from_workspace` call — and asserts the SSE stream,
 * the single `deploy_function` MCP dispatch, and the persisted DB rows.
 *
 * Gate: requires TEST_DATABASE_URL to run (describe.skipIf(!RUN)) — same
 * pattern as dashboard-agent.e2e.test.ts.
 *
 * External I/O mocked:
 *   - AI gateway:  global.fetch stubbed with hand-crafted OpenAI SSE deltas.
 *   - MCP client:  callMcpTool from mcp-client.ts mocked via vi.mock.
 *     `manage_repo` (pull_latest/push) is also stubbed so the loop's
 *     workspace-hydration and end-of-turn flush never hit real fetch.
 *
 * Real (not mocked):
 *   - Fastify server booted with dashboardAgentRoutes
 *   - pg.Pool → real Postgres database
 *   - runAgentTurn loop, file-ops, and the function deployer
 *
 * Run:
 *   TEST_DATABASE_URL=<postgres-url> DASHBOARD_AGENT_TOOL_CALL_LIMIT=8 \
 *     pnpm --filter control-api test dashboard-agent
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = !!DB_URL;

import { vi } from 'vitest';

vi.mock('../../services/dashboard-agent/mcp-client.js', () => ({
  callMcpTool: vi.fn(),
}));

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import { dashboardAgentRoutes } from '../dashboard-agent.js';
import { callMcpTool } from '../../services/dashboard-agent/mcp-client.js';

// ── Helpers (mirrors dashboard-agent.e2e.test.ts) ────────────────────────────

function makeSseStream(deltas: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const body =
    deltas.map((d) => `data: ${JSON.stringify(d)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

function gatewayResponse(deltas: object[]): Response {
  return { ok: true, body: makeSseStream(deltas) } as unknown as Response;
}

async function buildApp(userId: string | null, pool: pg.Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorateRequest('auth', null as any);
  app.addHook('onRequest', async (request) => {
    (request as any).auth = { userId, authMethod: 'jwt' as const, scopes: ['*'] };
  });

  app.decorate('controlDb', pool as any);
  await app.register(dashboardAgentRoutes);
  await app.ready();
  return app;
}

function parseSseFrames(body: string): unknown[] {
  return body
    .split('\n\n')
    .filter((segment) => segment.startsWith('data: '))
    .map((segment) => JSON.parse(segment.slice(6)));
}

/** Two-delta shape for one streamed tool_call: name-frame then args-frame. */
function toolCallDeltas(index: number, id: string, name: string, args: object): object[] {
  return [
    { choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: '' } }] }, finish_reason: null }] },
    {
      choices: [
        { delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null },
      ],
    },
  ];
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)('dashboard-agent fn-codegen e2e', () => {
  let pool: pg.Pool;

  const USER_A = randomUUID();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL!, max: 5 });
    process.env.DASHBOARD_ASSISTANT_ENABLED = '1';
  }, 30_000);

  afterAll(async () => {
    delete process.env.DASHBOARD_ASSISTANT_ENABLED;
    if (pool) {
      await pool.query(
        `DELETE FROM dashboard_agent_messages
         WHERE conversation_id IN (
           SELECT id FROM dashboard_agent_conversations WHERE user_id = $1
         )`,
        [USER_A],
      );
      await pool.query(`DELETE FROM dashboard_agent_conversations WHERE user_id = $1`, [USER_A]);
      await pool.end();
    }
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Case L: write_file x2 + deploy_function_from_workspace smoke', () => {
    it(
      'writes two files, deploys the function, and streams progress through to done',
      async () => {
        const app = await buildApp(USER_A, pool);

        try {
          const convR = await app.inject({
            method: 'POST',
            url: '/conversations',
            payload: { title: 'e2e-case-l-fn-codegen', model: 'anthropic/claude-haiku-4.5' },
          });
          expect(convR.statusCode).toBe(201);
          const { conversation } = convR.json<{ conversation: { id: string } }>();
          const conversationId = conversation.id;

          const handlerSrc =
            'export function handler() { return new Response(JSON.stringify({ hi: "world" }), ' +
            '{headers:{"content-type":"application/json"}}); }';
          const pkgJson = '{"name":"hello","version":"1.0.0"}';

          // ── Mock gateway: pass 1 (three tool_calls) then pass 2 (final tokens) ─
          global.fetch = vi
            .fn()
            .mockResolvedValueOnce(
              gatewayResponse([
                { choices: [{ delta: { content: "Sure, I'll add that function." }, finish_reason: null }] },
                ...toolCallDeltas(0, 'call_w1', 'write_file', {
                  app_id: 'app_test',
                  path: 'functions/hello/index.ts',
                  content: handlerSrc,
                }),
                ...toolCallDeltas(1, 'call_w2', 'write_file', {
                  app_id: 'app_test',
                  path: 'functions/hello/package.json',
                  content: pkgJson,
                }),
                ...toolCallDeltas(2, 'call_d1', 'deploy_function_from_workspace', {
                  app_id: 'app_test',
                  function_name: 'hello',
                }),
                { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
              ]),
            )
            .mockResolvedValueOnce(
              gatewayResponse([
                { choices: [{ delta: { content: 'Deployed hello.' }, finish_reason: null }] },
                { choices: [{ delta: {}, finish_reason: 'stop' }] },
              ]),
            );

          // ── Mock MCP: manage_repo (hydration + flush) is a no-op empty repo;
          //     deploy_function returns a live function.
          vi.mocked(callMcpTool).mockImplementation(async (name: string, args: unknown) => {
            if (name === 'manage_repo') {
              const action = (args as any)?.action;
              if (action === 'pull_latest' || action === 'pull_snapshot') {
                return { ok: true, result: { snapshot_id: null, files: [] } };
              }
              return { ok: true, result: { snapshot_id: 'snap_noop' } };
            }
            if (name === 'deploy_function') {
              return {
                ok: true,
                result: {
                  id: 'fn_hello_123',
                  name: 'hello',
                  url: 'https://hello.functions.local',
                  triggers: [{ type: 'http' }],
                  deployedAt: '2026-07-09T00:00:00Z',
                },
              };
            }
            return { ok: true, result: {} };
          });

          // ── POST /messages ─────────────────────────────────────────────────
          const msgR = await app.inject({
            method: 'POST',
            url: '/messages',
            payload: {
              conversation_id: conversationId,
              message: 'Add an HTTP function called hello that returns {hi:"world"}',
              model: 'anthropic/claude-haiku-4.5',
            },
            headers: { authorization: 'Bearer test-jwt-a' },
          });

          expect(msgR.statusCode).toBe(200);
          expect(msgR.headers['content-type']).toContain('text/event-stream');

          const frames = parseSseFrames(msgR.body) as Array<{ type: string; [k: string]: unknown }>;

          // ── Assert: two file_change events, one per write_file ──────────────
          const fileChanges = frames.filter((f) => f.type === 'file_change');
          expect(fileChanges).toHaveLength(2);
          expect(fileChanges.map((f) => f.path)).toEqual([
            'functions/hello/index.ts',
            'functions/hello/package.json',
          ]);

          // ── Assert: function_deployment_progress events, ending live ─────────
          const progress = frames.filter((f) => f.type === 'function_deployment_progress');
          expect(progress.length).toBeGreaterThan(0);
          const liveEvt = progress.find((f) => f.status === 'live');
          expect(liveEvt).toMatchObject({
            status: 'live',
            url: 'https://hello.functions.local',
            function_name: 'hello',
          });

          // ── Assert: deploy_function called exactly once with the right args ──
          const deployCalls = vi
            .mocked(callMcpTool)
            .mock.calls.filter(([name]) => name === 'deploy_function');
          expect(deployCalls).toHaveLength(1);
          const [, deployArgs] = deployCalls[0];
          expect(deployArgs).toMatchObject({ app_id: 'app_test', name: 'hello' });
          expect(typeof (deployArgs as any).code).toBe('string');
          expect((deployArgs as any).code).toContain('export function handler');

          // ── Assert: done frame present, and it's the last frame ─────────────
          expect(frames.some((f) => f.type === 'done')).toBe(true);
          expect(frames[frames.length - 1]?.type).toBe('done');

          // ── Assert: DB rows for the deploy_function_from_workspace tool call ─
          const assistantToolRow = await pool.query(
            `SELECT role, tool_call_id, tool_name FROM dashboard_agent_messages
             WHERE conversation_id = $1 AND role = 'assistant' AND tool_call_id = 'call_d1'`,
            [conversationId],
          );
          expect(assistantToolRow.rows).toHaveLength(1);
          expect(assistantToolRow.rows[0]).toMatchObject({
            tool_name: 'deploy_function_from_workspace',
          });

          const toolResultRow = await pool.query(
            `SELECT role, tool_call_id, tool_name, tool_result FROM dashboard_agent_messages
             WHERE conversation_id = $1 AND role = 'tool' AND tool_call_id = 'call_d1'`,
            [conversationId],
          );
          expect(toolResultRow.rows).toHaveLength(1);
          expect(toolResultRow.rows[0].tool_name).toBe('deploy_function_from_workspace');
          expect(toolResultRow.rows[0].tool_result).toMatchObject({
            url: 'https://hello.functions.local',
          });
        } finally {
          await app.close();
        }
      },
      30_000,
    );
  });
});
