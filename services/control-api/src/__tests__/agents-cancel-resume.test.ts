process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import {
  installAgentTestMocks, seedTestApp, cleanupTestApp,
  closeTestPool, TEST_USER_ID,
} from './agent-test-helpers.js';
installAgentTestMocks();

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { agentsRoutes, setRuntimeClient } from '../routes/agents.js';

vi.mock('../services/agent-runtime-client.js', () => ({
  startRun: vi.fn(async (_runId: string) => undefined),
  cancelRun: vi.fn(async (_runId: string) => undefined),
  resumeRun: vi.fn(async (_runId: string, _input: unknown) => undefined),
  AgentRuntimeError: class extends Error {},
}));

const OWNER_ID = TEST_USER_ID;
const OTHER_ID = '00000000-0000-0000-0000-000000000302';

const app = Fastify({ logger: false });
let appId: string;
let agentName: string;

const validSpec = {
  spec_version: '1',
  entry: 'step',
  nodes: {
    step: {
      type: 'llm',
      model: 'm',
      system_prompt: 's',
      input_template: '{{ state.x }}',
      output_key: 'y',
    },
    end: { type: 'end', output_template: '{{ state.y }}' },
  },
  edges: [{ from: 'step', to: 'end' }],
  tools: { builtin: [], mcp_servers: [], functions: [] },
  limits: {
    max_steps: 10,
    max_tool_calls: 0,
    max_parallel_tools: 1,
    timeout_seconds: 60,
    human_timeout_seconds: 86400,
  },
};

beforeAll(async () => {
  app.register(databasePlugin);
  app.addHook('onRequest', (req, _reply, done) => {
    const u = req.headers['x-test-user-id'];
    req.auth = {
      userId: typeof u === 'string' && u.length > 0 ? u : OWNER_ID,
      authMethod: 'api_key',
      scopes: ['*'],
    };
    done();
  });
  app.register(agentsRoutes);
  await app.ready();

  appId = await seedTestApp({ prefix: 'cancel' });
  agentName = 'my-agent';

  await app.inject({
    method: 'POST',
    url: `/v1/${appId}/agents`,
    payload: { name: agentName, graph_spec: validSpec },
  });
});

afterAll(async () => {
  setRuntimeClient(undefined);
  await app.close();
  await cleanupTestApp(appId);
  await closeTestPool();
});

/** Create a run directly in the DB with an arbitrary status. */
async function seedRun(status: string): Promise<string> {
  // First get the agent id
  const agentRow = await app.controlDb.query(
    `SELECT id FROM agents WHERE app_id = $1 AND name = $2`,
    [appId, agentName],
  );
  const agentId = agentRow.rows[0].id as string;

  const r = await app.controlDb.query(
    `INSERT INTO agent_runs
       (app_id, agent_id, caller_kind, input, status)
     VALUES ($1, $2, 'function', '{}', $3)
     RETURNING id`,
    [appId, agentId, status],
  );
  return r.rows[0].id as string;
}

describe('POST /cancel', () => {
  it('202 + calls cancelRun for a valid run', async () => {
    const cancelFn = vi.fn(async (_runId: string) => undefined);
    setRuntimeClient({
      startRun: vi.fn(async () => undefined),
      cancelRun: cancelFn,
      resumeRun: vi.fn(async () => undefined),
    });

    const runId = await seedRun('running');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/agents/${agentName}/runs/${runId}/cancel`,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ run_id: runId, status: 'cancelling' });
    expect(cancelFn).toHaveBeenCalledWith(runId, 'local');

    setRuntimeClient(undefined);
  });

  it('403 for a non-owner', async () => {
    const runId = await seedRun('running');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/agents/${agentName}/runs/${runId}/cancel`,
      headers: { 'x-test-user-id': OTHER_ID },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404 for a missing run', async () => {
    const fakeRunId = '00000000-0000-0000-0000-000000000000';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/agents/${agentName}/runs/${fakeRunId}/cancel`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /resume', () => {
  it('202 + calls resumeRun for a paused run', async () => {
    const resumeFn = vi.fn(async (_runId: string, _input: unknown) => undefined);
    setRuntimeClient({
      startRun: vi.fn(async () => undefined),
      cancelRun: vi.fn(async () => undefined),
      resumeRun: resumeFn,
    });

    const runId = await seedRun('paused');
    const input = { answer: 42 };
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/agents/${agentName}/runs/${runId}/resume`,
      payload: { input },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ run_id: runId, status: 'queued' });
    expect(resumeFn).toHaveBeenCalledWith(runId, 'local', input);

    setRuntimeClient(undefined);
  });

  it('409 when run is not paused', async () => {
    const runId = await seedRun('running');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/agents/${agentName}/runs/${runId}/resume`,
      payload: { input: {} },
    });
    expect(res.statusCode).toBe(409);
  });

  it('400 for invalid body (non-object)', async () => {
    const runId = await seedRun('paused');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/agents/${agentName}/runs/${runId}/resume`,
      payload: 'not-an-object',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });
});
