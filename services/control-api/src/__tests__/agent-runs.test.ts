// Must be set before any service module that reads AUTH_ENCRYPTION_KEY is loaded.
// AES-256-GCM requires a 64-char hex string (32 bytes).
process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { initRoutes } from '../routes/init.js';
import { agentsRoutes } from '../routes/agents.js';

vi.mock('../services/agent-runtime-client.js', () => ({
  startRun: vi.fn(async (_runId: string) => undefined),
  AgentRuntimeError: class extends Error {},
}));

const TEST_USER_ID = '00000000-0000-0000-0000-000000000002';

const app = Fastify({ logger: false });
let appId: string;

const validSpec = {
  spec_version: '1', entry: 'a',
  nodes: {
    a: { type: 'llm', model: 'm', system_prompt: 's',
         input_template: '{{ state.x }}', output_key: 'y' },
    z: { type: 'end', output_template: '{{ state.y }}' },
  },
  edges: [{ from: 'a', to: 'z' }],
  tools: { builtin: [], mcp_servers: [], functions: [] },
  limits: { max_steps: 10, max_tool_calls: 0, max_parallel_tools: 1,
            timeout_seconds: 60, human_timeout_seconds: 86400 },
};

beforeAll(async () => {
  app.register(databasePlugin);
  // Inject auth context via onRequest hook (same pattern as test-helpers/build-app.ts)
  app.addHook('onRequest', (req, _reply, done) => {
    const u = req.headers['x-test-user-id'];
    req.auth = {
      userId: typeof u === 'string' && u.length > 0 ? u : TEST_USER_ID,
      authMethod: 'api_key',
      scopes: ['*'],
    };
    done();
  });
  app.register(initRoutes);
  app.register(agentsRoutes);
  await app.ready();

  // Ensure test user exists in the control DB
  await app.controlDb.query(
    `INSERT INTO platform_users (id, email, created_at)
     VALUES ($1, 'agent-runs-test@example.com', now())
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID],
  );
  // Remove apps from previous test runs to avoid hitting the project limit
  await app.controlDb.query(`DELETE FROM apps WHERE owner_id = $1`, [TEST_USER_ID]);

  const initRes = await app.inject({
    method: 'POST',
    url: '/init',
    payload: { name: `runs-test-${Date.now()}` },
  });
  appId = initRes.json().app_id;

  await app.inject({
    method: 'POST',
    url: `/v1/${appId}/agents`,
    payload: { name: 'echo', graph_spec: validSpec },
  });
});

afterAll(async () => { await app.close(); });

describe('agent runs', () => {
  it('creates a run and returns 202 with a run_id', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents/echo/runs`,
      payload: { input: { x: 'hi' } },
    });
    expect(res.statusCode).toBe(202);
    expect(typeof res.json().run_id).toBe('string');
  });

  it('idempotency key returns the same run_id', async () => {
    const first = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents/echo/runs`,
      payload: { input: { x: 'hi' }, idempotency_key: 'key-1' },
    });
    const second = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents/echo/runs`,
      payload: { input: { x: 'different' }, idempotency_key: 'key-1' },
    });
    expect(first.json().run_id).toBe(second.json().run_id);
  });

  it('GET /runs/:id returns the run', async () => {
    const created = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents/echo/runs`,
      payload: { input: { x: 'q' } },
    });
    const runId = created.json().run_id;
    const res = await app.inject({
      method: 'GET', url: `/v1/${appId}/agents/echo/runs/${runId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.id).toBe(runId);
  });
});
