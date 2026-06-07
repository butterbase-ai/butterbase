process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import {
  installAgentTestMocks, seedTestApp, cleanupTestApp,
  closeTestPool, TEST_USER_ID,
} from './agent-test-helpers.js';
installAgentTestMocks();

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { agentsRoutes } from '../routes/agents.js';

const OWNER_ID = TEST_USER_ID;
const OTHER_ID = '00000000-0000-0000-0000-000000000402';

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

  appId = await seedTestApp({ prefix: 'events' });
  agentName = 'my-agent';

  await app.inject({
    method: 'POST',
    url: `/v1/${appId}/agents`,
    payload: { name: agentName, graph_spec: validSpec },
  });
});

afterAll(async () => {
  await app.close();
  await cleanupTestApp(appId);
  await closeTestPool();
});

/** Create a run directly in the DB. */
async function seedRun(): Promise<string> {
  // First get the agent id
  const agentRow = await app.controlDb.query(
    `SELECT id FROM agents WHERE app_id = $1 AND name = $2`,
    [appId, agentName],
  );
  const agentId = agentRow.rows[0].id as string;

  const r = await app.controlDb.query(
    `INSERT INTO agent_runs
       (app_id, agent_id, caller_kind, input, status)
     VALUES ($1, $2, 'function', '{}', 'running')
     RETURNING id`,
    [appId, agentId],
  );
  return r.rows[0].id as string;
}

/** Insert test events into agent_run_events. */
async function seedEvents(runId: string, count: number): Promise<void> {
  for (let seq = 1; seq <= count; seq++) {
    await app.controlDb.query(
      `INSERT INTO agent_run_events (run_id, seq, type, payload, created_at)
       VALUES ($1, $2, 'node_start', '{}', now())`,
      [runId, seq],
    );
  }
}

describe('GET /events.json', () => {
  it('returns all events with no params', async () => {
    const runId = await seedRun();
    await seedEvents(runId, 5);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/agents/${agentName}/runs/${runId}/events.json`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.events).toHaveLength(5);
    expect(body.events[0].seq).toBe(1);
    expect(body.events[4].seq).toBe(5);
  });

  it('filters events by since_seq', async () => {
    const runId = await seedRun();
    await seedEvents(runId, 5);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/agents/${agentName}/runs/${runId}/events.json?since_seq=2`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.events).toHaveLength(3);
    expect(body.events[0].seq).toBe(3);
    expect(body.events[1].seq).toBe(4);
    expect(body.events[2].seq).toBe(5);
  });

  it('applies limit with since_seq', async () => {
    const runId = await seedRun();
    await seedEvents(runId, 5);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/agents/${agentName}/runs/${runId}/events.json?since_seq=2&limit=1`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.events).toHaveLength(1);
    expect(body.events[0].seq).toBe(3);
  });

  it('returns 403 for non-owner', async () => {
    const runId = await seedRun();
    await seedEvents(runId, 5);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/agents/${agentName}/runs/${runId}/events.json`,
      headers: { 'x-test-user-id': OTHER_ID },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for missing run', async () => {
    const fakeRunId = '00000000-0000-0000-0000-000000000000';
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/agents/${agentName}/runs/${fakeRunId}/events.json`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('clamps limit to 500 with large value', async () => {
    const runId = await seedRun();
    await seedEvents(runId, 5);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/agents/${agentName}/runs/${runId}/events.json?limit=99999`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    // Should not error; we just return the 5 events that exist
    expect(body.events).toHaveLength(5);
  });
});
