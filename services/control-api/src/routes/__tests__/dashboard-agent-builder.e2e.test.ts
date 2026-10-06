/**
 * Builder-mode end-to-end tests for the dashboard-agent.
 *
 * Proves the full scaffold → deploy loop:
 *   Turn 1 — "scaffold a todo app": write_file → first-touch hydration → repo push with ALL files
 *   Turn 2 — "deploy": deploy_frontend → deployment_progress events in SSE stream + usage rows
 *
 * Gate: requires TEST_DATABASE_URL (describe.skipIf when unset).
 *
 * External I/O mocked:
 *   - AI gateway:     global.fetch stubbed with hand-crafted OpenAI SSE deltas
 *   - MCP client:     callMcpTool mocked via vi.mock (intercepts manage_repo calls)
 *   - deploy.ts:      createDeployer mocked to bypass zip-upload and polling
 *   - template-loader: loadTemplate mocked to return a deterministic fixed set
 *
 * Real (not mocked):
 *   - Fastify server
 *   - pg.Pool → real Postgres (TEST_DATABASE_URL)
 *   - runAgentTurn loop + all store functions
 *
 * Run:
 *   TEST_DATABASE_URL=<postgres-url> pnpm --filter control-api test dashboard-agent-builder.e2e
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = !!DB_URL;

// ── Module mocks (hoisted by Vitest before imports) ──────────────────────────
import { vi } from 'vitest';

vi.mock('../../services/dashboard-agent/mcp-client.js', () => ({
  callMcpTool: vi.fn(),
}));

vi.mock('../../services/dashboard-agent/deploy.js', () => ({
  createDeployer: vi.fn(),
}));

vi.mock('../../services/dashboard-agent/template-loader.js', () => ({
  loadTemplate: vi.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import { dashboardAgentRoutes } from '../dashboard-agent.js';
import { callMcpTool } from '../../services/dashboard-agent/mcp-client.js';
import { createDeployer } from '../../services/dashboard-agent/deploy.js';
import { loadTemplate } from '../../services/dashboard-agent/template-loader.js';

// ── Template fixture — deterministic set used across assertions ───────────────
const TEMPLATE_FILES = [
  { path: 'index.html', content: '<!DOCTYPE html><html><body></body></html>' },
  { path: 'package.json', content: '{"name":"app","version":"0.0.0"}' },
  { path: 'vite.config.ts', content: 'export default {}' },
  { path: 'src/main.tsx', content: 'import React from "react"' },
  { path: 'src/index.css', content: 'body { margin: 0 }' },
  { path: 'src/lib/butterbase.ts', content: '// butterbase client' },
];

const TEMPLATE_PATHS = TEMPLATE_FILES.map((f) => f.path);

// ── SSE helpers (same pattern as dashboard-agent.e2e.test.ts) ─────────────────

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

function gatewayResponse(deltas: object[]): Response {
  return { ok: true, body: makeSseStream(deltas) } as unknown as Response;
}

function parseSseFrames(body: string): unknown[] {
  return body
    .split('\n\n')
    .filter((segment) => segment.startsWith('data: '))
    .map((segment) => JSON.parse(segment.slice(6)));
}

// ── App builder ───────────────────────────────────────────────────────────────

async function buildApp(userId: string, pool: pg.Pool): Promise<FastifyInstance> {
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

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)('dashboard-agent builder-mode e2e', () => {
  let pool: pg.Pool;
  const USER = randomUUID();

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
        [USER],
      );
      await pool.query(
        `DELETE FROM dashboard_agent_conversations WHERE user_id = $1`,
        [USER],
      );
      await pool.query(
        `DELETE FROM dashboard_agent_usage WHERE user_id = $1`,
        [USER],
      );
      await pool.end();
    }
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    'two-turn scaffold+deploy: emits file_change+active_app_change on turn 1; deployment_progress on turn 2; two usage rows land',
    async () => {
      const app = await buildApp(USER, pool);

      try {
        // ── 1. Set up mocks ─────────────────────────────────────────────────

        // loadTemplate — returns fixed file set so we can assert exact paths in push
        vi.mocked(loadTemplate).mockResolvedValue(TEMPLATE_FILES);

        // createDeployer — bypasses real zip-upload + polling; emits queued→live
        vi.mocked(createDeployer).mockImplementation((deps) => ({
          async deploy() {
            deps.onDeploymentProgress({ deployment_id: 'dep_e2e', status: 'queued' });
            deps.onDeploymentProgress({
              deployment_id: 'dep_e2e',
              status: 'live',
              url: 'https://x.butterbase.dev',
            });
            return { ok: true as const, deployment_id: 'dep_e2e', url: 'https://x.butterbase.dev' };
          },
        }));

        // callMcpTool — intercepts manage_repo pull_latest + push
        const pushCallArgs: Array<{ app_id: string; files: Array<{ path: string }> }> = [];
        vi.mocked(callMcpTool).mockImplementation(async (name, args: any) => {
          if (name === 'manage_repo') {
            if (args.action === 'pull_latest') {
              // Return empty repo — triggers template scaffold path
              return { ok: true as const, result: { snapshot_id: null, files: [] } };
            }
            if (args.action === 'push') {
              pushCallArgs.push({ app_id: args.app_id, files: args.files ?? [] });
              return { ok: true as const, result: { snapshot_id: 'snap_e2e_1' } };
            }
          }
          return { ok: true as const, result: {} };
        });

        // ── 2. Create conversation ──────────────────────────────────────────
        const convR = await app.inject({
          method: 'POST',
          url: '/conversations',
          payload: { title: 'builder-e2e', model: 'gpt-4o' },
        });
        expect(convR.statusCode).toBe(201);
        const { conversation } = convR.json<{ conversation: { id: string } }>();
        const conversationId = conversation.id;

        // ── 3. Turn 1 gateway mocks ─────────────────────────────────────────
        // Pass 1: tool_call(write_file, {app_id:'app_test', path:'src/App.tsx', content:'/* todo */'})
        const turn1Pass1 = gatewayResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tc_write_1',
                      function: { name: 'write_file', arguments: '' },
                    },
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
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: JSON.stringify({
                          app_id: 'app_test',
                          path: 'src/App.tsx',
                          content: '/* todo */',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 50, completion_tokens: 20 },
          },
        ]);

        // Pass 2: final assistant message
        const turn1Pass2 = gatewayResponse([
          { choices: [{ delta: { content: 'scaffolded' }, finish_reason: null }] },
          {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 60, completion_tokens: 5 },
          },
        ]);

        // ── 4. Turn 2 gateway mocks ─────────────────────────────────────────
        // Pass 1: tool_call(deploy_frontend, {app_id:'app_test'})
        const turn2Pass1 = gatewayResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tc_deploy_1',
                      function: { name: 'deploy_frontend', arguments: '' },
                    },
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
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: JSON.stringify({ app_id: 'app_test' }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 55, completion_tokens: 15 },
          },
        ]);

        // Pass 2: final assistant message
        const turn2Pass2 = gatewayResponse([
          { choices: [{ delta: { content: 'shipped' }, finish_reason: null }] },
          {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 65, completion_tokens: 5 },
          },
        ]);

        global.fetch = vi.fn()
          .mockResolvedValueOnce(turn1Pass1)
          .mockResolvedValueOnce(turn1Pass2)
          .mockResolvedValueOnce(turn2Pass1)
          .mockResolvedValueOnce(turn2Pass2);

        // ── 5. POST /messages — Turn 1 ──────────────────────────────────────
        const turn1R = await app.inject({
          method: 'POST',
          url: '/messages',
          payload: {
            conversation_id: conversationId,
            message: 'scaffold a todo app in app_test',
            model: 'gpt-4o',
          },
          headers: { authorization: 'Bearer test-jwt' },
        });

        expect(turn1R.statusCode).toBe(200);
        expect(turn1R.headers['content-type']).toContain('text/event-stream');

        const turn1Frames = parseSseFrames(turn1R.body);

        // Assertion 1a: SSE contains file_change event for src/App.tsx
        const fileChangeEvt = turn1Frames.find(
          (f: any) => f.type === 'file_change' && f.path === 'src/App.tsx',
        );
        expect(fileChangeEvt, 'Turn 1 SSE should contain file_change for src/App.tsx').toBeTruthy();
        expect(fileChangeEvt).toMatchObject({
          type: 'file_change',
          app_id: 'app_test',
          path: 'src/App.tsx',
          kind: 'write',
        });

        // Assertion 1b: SSE contains active_app_change event for app_test
        const activeAppEvt = turn1Frames.find(
          (f: any) => f.type === 'active_app_change' && f.app_id === 'app_test',
        );
        expect(activeAppEvt, 'Turn 1 SSE should contain active_app_change for app_test').toBeTruthy();

        // Assertion 1c: Turn 1 ends with done
        const lastTurn1Frame = turn1Frames[turn1Frames.length - 1];
        expect(lastTurn1Frame).toMatchObject({ type: 'done' });

        // Assertion 2: manage_repo.push called with src/App.tsx + ALL template files
        expect(pushCallArgs).toHaveLength(1);
        const pushedPaths = pushCallArgs[0].files.map((f: { path: string }) => f.path);
        expect(pushCallArgs[0].app_id).toBe('app_test');

        // src/App.tsx must be in the push (agent-written file)
        expect(pushedPaths).toContain('src/App.tsx');

        // All template paths must also be in the push (first-touch hydration)
        for (const tmplPath of TEMPLATE_PATHS) {
          // src/App.tsx from template is overwritten by the agent — still present
          expect(pushedPaths, `template file ${tmplPath} should be in push`).toContain(tmplPath);
        }

        // ── 6. POST /messages — Turn 2 ──────────────────────────────────────
        const turn2R = await app.inject({
          method: 'POST',
          url: '/messages',
          payload: {
            conversation_id: conversationId,
            message: 'deploy',
            model: 'gpt-4o',
          },
          headers: { authorization: 'Bearer test-jwt' },
        });

        expect(turn2R.statusCode).toBe(200);
        expect(turn2R.headers['content-type']).toContain('text/event-stream');

        const turn2Frames = parseSseFrames(turn2R.body);

        // Assertion 3: SSE contains deployment_progress with status 'live'
        const liveEvt = turn2Frames.find(
          (f: any) => f.type === 'deployment_progress' && f.status === 'live',
        );
        expect(liveEvt, 'Turn 2 SSE should contain deployment_progress with status live').toBeTruthy();
        expect(liveEvt).toMatchObject({
          type: 'deployment_progress',
          deployment_id: 'dep_e2e',
          status: 'live',
          url: 'https://x.butterbase.dev',
        });

        // Assertion 4: two dashboard_agent_usage rows — one per turn
        type UsageRow = {
          conversation_id: string;
          file_writes_count: number;
          deployments_count: number;
        };
        const { rows: usageRows } = await pool.query<UsageRow>(
          `SELECT conversation_id, file_writes_count, deployments_count
           FROM dashboard_agent_usage
           WHERE conversation_id = $1
           ORDER BY created_at ASC`,
          [conversationId],
        );

        expect(usageRows).toHaveLength(2);

        // Turn 1: wrote one file
        expect(usageRows[0].file_writes_count).toBe(1);
        expect(usageRows[0].deployments_count).toBe(0);

        // Turn 2: deployed once
        expect(usageRows[1].file_writes_count).toBe(0);
        expect(usageRows[1].deployments_count).toBe(1);
      } finally {
        await app.close();
      }
    },
    60_000,
  );
});
