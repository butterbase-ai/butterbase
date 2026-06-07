process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import {
  installAgentTestMocks, seedTestApp, cleanupTestApp,
  closeTestPool, TEST_USER_ID,
} from './agent-test-helpers.js';
installAgentTestMocks();

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { agentsRoutes } from '../routes/agents.js';

vi.mock('../services/agent-runtime-client.js', () => ({
  startRun: vi.fn(async (_runId: string) => undefined),
  AgentRuntimeError: class extends Error {},
}));

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
  app.addHook('onRequest', (req, _reply, done) => {
    const u = req.headers['x-test-user-id'];
    req.auth = {
      userId: typeof u === 'string' && u.length > 0 ? u : TEST_USER_ID,
      authMethod: 'api_key',
      scopes: ['*'],
    };
    done();
  });
  app.register(agentsRoutes);
  await app.ready();

  appId = await seedTestApp({ prefix: 'runs' });

  await app.inject({
    method: 'POST',
    url: `/v1/${appId}/agents`,
    payload: { name: 'echo', graph_spec: validSpec },
  });
});

afterAll(async () => {
  await app.close();
  await cleanupTestApp(appId);
  await closeTestPool();
});

describe('agent runs', () => {
  it('creates a run and returns 202 with a run_id', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents/echo/runs`,
      payload: { input: { x: 'hi' } },
    });
    expect(res.statusCode).toBe(202);
    expect(typeof res.json().run_id).toBe('string');
  });

  it('idempotency replay (same key + same payload) returns the same run_id with 202', async () => {
    const first = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents/echo/runs`,
      payload: { input: { x: 'hi' }, idempotency_key: 'key-replay' },
    });
    const second = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents/echo/runs`,
      payload: { input: { x: 'hi' }, idempotency_key: 'key-replay' },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json().run_id).toBe(second.json().run_id);
  });

  it('idempotency key reuse with different payload returns 409 with existing_run_id', async () => {
    const first = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents/echo/runs`,
      payload: { input: { x: 'hi' }, idempotency_key: 'key-conflict' },
    });
    const second = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents/echo/runs`,
      payload: { input: { x: 'different' }, idempotency_key: 'key-conflict' },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('idempotency_key_reuse');
    expect(second.json().existing_run_id).toBe(first.json().run_id);
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
