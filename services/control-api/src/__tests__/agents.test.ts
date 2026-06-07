// Must be set before any service module that reads AUTH_ENCRYPTION_KEY is loaded.
// AES-256-GCM requires a 64-char hex string (32 bytes).
process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { initRoutes } from '../routes/init.js';
import { agentsRoutes, setProbeFn, setRuntimeClient } from '../routes/agents.js';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

const app = Fastify({ logger: false });
let appId: string;

beforeAll(async () => {
  // Stub the runtime client so startRun doesn't call the real agent-runtime service.
  setRuntimeClient({
    startRun: async () => {},
    cancelRun: async () => {},
    resumeRun: async () => {},
  });

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
     VALUES ($1, 'agents-test@example.com', now())
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID],
  );

  const res = await app.inject({
    method: 'POST',
    url: '/init',
    payload: { name: `agents-test-${Date.now()}` },
  });
  appId = res.json().app_id;
});

afterAll(async () => {
  await app.close();
});

const validSpec = {
  spec_version: '1',
  entry: 'answer',
  nodes: {
    answer: {
      type: 'llm',
      model: 'anthropic/claude-3.5-sonnet',
      system_prompt: 'Be brief.',
      input_template: 'Echo: {{ state.user_input }}',
      output_key: 'reply',
    },
    done: { type: 'end', output_template: '{{ state.reply }}' },
  },
  edges: [{ from: 'answer', to: 'done' }],
  tools: { builtin: [], mcp_servers: [], functions: [] },
  limits: {
    max_steps: 10,
    max_tool_calls: 0,
    max_parallel_tools: 1,
    timeout_seconds: 60,
    human_timeout_seconds: 86400,
  },
};

describe('agents CRUD', () => {
  it('creates an agent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/agents`,
      payload: { name: 'echo', graph_spec: validSpec },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().agent.name).toBe('echo');
  });

  it('rejects an invalid graph_spec', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/agents`,
      payload: {
        name: 'broken',
        graph_spec: { ...validSpec, entry: 'nonexistent' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists agents', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/agents`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agents.length).toBeGreaterThan(0);
  });

  it('validates a spec without creating', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/agents/echo/validate`,
      payload: { graph_spec: validSpec },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });

  it('patches visibility and rate limits', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/${appId}/agents/echo`,
      payload: {
        visibility: 'authenticated',
        max_runs_per_user_per_hour: 10,
        daily_budget_usd: 5,
      },
    });
    expect(res.statusCode).toBe(200);
    const a = res.json().agent;
    expect(a.visibility).toBe('authenticated');
    expect(a.max_runs_per_user_per_hour).toBe(10);
    expect(a.daily_budget_usd).toBe('5.0000');
  });
});

describe('MCP servers CRUD', () => {
  let serverId: string;

  it('creates an MCP server with a masked auth header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/mcp-servers`,
      payload: {
        name: 'linear',
        transport: 'http',
        url: 'https://mcp.example.com',
        auth_header: 'Bearer secrettoken',
      },
    });
    expect(res.statusCode).toBe(201);
    serverId = res.json().server.id;
    expect(res.json().server.auth_header).not.toContain('secrettoken');
  });

  it('lists MCP servers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/mcp-servers`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().servers.length).toBeGreaterThan(0);
  });

  it('probe success — returns 200 with tool list and updates last_health', async () => {
    const fakeTools = [
      { name: 'search', description: 'Search the web' },
      { name: 'read', description: 'Read a file' },
    ];
    setProbeFn(async (_input) => ({ ok: true, tools: fakeTools }));
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/${appId}/mcp-servers/${serverId}/probe`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.tools).toEqual(fakeTools);

      // Verify DB: status = 'healthy', last_health is set
      const dbRow = await app.controlDb.query(
        `SELECT status, last_health FROM agent_mcp_servers WHERE id = $1`,
        [serverId],
      );
      expect(dbRow.rows[0].status).toBe('healthy');
      expect(dbRow.rows[0].last_health).not.toBeNull();
    } finally {
      setProbeFn(undefined);
    }
  });

  it('probe failure — returns 502 and sets status=unhealthy in DB', async () => {
    setProbeFn(async (_input) => ({ ok: false, error: 'connection refused' }));
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/${appId}/mcp-servers/${serverId}/probe`,
      });
      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('connection refused');

      // Verify DB: status = 'unhealthy'
      const dbRow = await app.controlDb.query(
        `SELECT status FROM agent_mcp_servers WHERE id = $1`,
        [serverId],
      );
      expect(dbRow.rows[0].status).toBe('unhealthy');
    } finally {
      setProbeFn(undefined);
    }
  });
});

describe('idempotency 409', () => {
  beforeAll(async () => {
    // Ensure the 'echo' agent exists for this describe block (it may already exist
    // if the agents CRUD tests ran first, so we ignore 409 conflict).
    await app.inject({
      method: 'POST',
      url: `/v1/${appId}/agents`,
      payload: { name: 'echo', graph_spec: validSpec },
    });
  });

  it('returns same run for same key + same payload', async () => {
    const key = `same-${Date.now()}`;
    const r1 = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents/echo/runs`,
      payload: { input: { q: 'hi' }, idempotency_key: key },
    });
    const r2 = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents/echo/runs`,
      payload: { input: { q: 'hi' }, idempotency_key: key },
    });
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(202);
    expect(r2.json().run_id).toBe(r1.json().run_id);
  });

  it('returns 409 for same key + different payload', async () => {
    const key = `diff-${Date.now()}`;
    const r1 = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents/echo/runs`,
      payload: { input: { q: 'hi' }, idempotency_key: key },
    });
    const r2 = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents/echo/runs`,
      payload: { input: { q: 'BYE' }, idempotency_key: key },
    });
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe('idempotency_key_reuse');
    expect(r2.json().existing_run_id).toBe(r1.json().run_id);
  });
});

describe('visibility guard (ACL-only)', () => {
  it('rejects visibility=public when graph contains a write builtin', async () => {
    const writeSpec = {
      ...validSpec,
      nodes: {
        ...validSpec.nodes,
        write: {
          type: 'tool',
          tool_ref: { source: 'builtin', name: 'insert_row' },
          args_template: { table: 'reports', row: {} },
          output_key: 'r',
        },
      },
      edges: [{ from: 'write', to: 'done' }],
      entry: 'write',
      tools: { builtin: ['insert_row'], mcp_servers: [], functions: [] },
    };
    const create = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents`,
      payload: { name: 'writer', graph_spec: writeSpec },
    });
    expect(create.statusCode).toBe(201);

    const res = await app.inject({
      method: 'PATCH', url: `/v1/${appId}/agents/writer`,
      payload: { visibility: 'public' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsafe_public_visibility');
    expect(res.json().offending_tools).toContain('insert_row');
  });

  it('rejects visibility=public when any tool ref has mode_override=read_write', async () => {
    const spec = {
      ...validSpec,
      nodes: {
        ...validSpec.nodes,
        n: {
          type: 'tool',
          tool_ref: { source: 'mcp', server_id: '00000000-0000-0000-0000-000000000001',
                      name: 'do_thing', mode_override: 'read_write' },
          args_template: {},
          output_key: 'r',
        },
      },
      edges: [{ from: 'n', to: 'done' }],
      entry: 'n',
    };
    const create = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents`,
      payload: { name: 'mcp-writer', graph_spec: spec },
    });
    expect(create.statusCode).toBe(201);
    const res = await app.inject({
      method: 'PATCH', url: `/v1/${appId}/agents/mcp-writer`,
      payload: { visibility: 'public' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsafe_public_visibility');
  });

  it('allows when safety_acknowledged=true', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/v1/${appId}/agents/writer`,
      payload: { visibility: 'public', safety_acknowledged: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.visibility).toBe('public');
  });

  it('allows visibility=public when graph is read-only', async () => {
    const create = await app.inject({
      method: 'POST', url: `/v1/${appId}/agents`,
      payload: { name: 'reader', graph_spec: validSpec },
    });
    expect(create.statusCode).toBe(201);
    const res = await app.inject({
      method: 'PATCH', url: `/v1/${appId}/agents/reader`,
      payload: { visibility: 'public' },
    });
    expect(res.statusCode).toBe(200);
  });
});
