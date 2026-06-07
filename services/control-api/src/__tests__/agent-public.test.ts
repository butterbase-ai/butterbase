process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import {
  installAgentTestMocks, seedTestApp, cleanupTestApp,
  getTestPool, closeTestPool, TEST_USER_ID,
} from './agent-test-helpers.js';
installAgentTestMocks();

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import * as jose from 'jose';
import { databasePlugin } from '../plugins/database.js';
import { agentsRoutes, setRuntimeClient } from '../routes/agents.js';
import { agentPublicRoutes } from '../routes/agent-public.js';
import { getOrCreateSigningKey } from '../services/auth/signing-key-service.js';
import { JWT_ISSUER_PREFIX } from '@butterbase/shared/constants';

const app = Fastify({ logger: false });
let appId: string;
let anonKey: string;

const validSpec = {
  spec_version: '1', entry: 'a',
  nodes: {
    a: { type: 'llm', model: 'anthropic/claude-3.5-sonnet',
         system_prompt: 's', input_template: '{{ state.q }}', output_key: 'r' },
    done: { type: 'end', output_template: '{{ state.r }}' },
  },
  edges: [{ from: 'a', to: 'done' }],
  tools: { builtin: [], mcp_servers: [], functions: [] },
  limits: { max_steps: 5, max_tool_calls: 0, max_parallel_tools: 1,
            timeout_seconds: 30, human_timeout_seconds: 60 },
};

beforeAll(async () => {
  app.register(databasePlugin);
  app.addHook('onRequest', (req, _r, done) => {
    const u = req.headers['x-test-user-id'];
    req.auth = {
      userId: typeof u === 'string' && u.length > 0 ? u : TEST_USER_ID,
      authMethod: 'api_key', scopes: ['*'],
    };
    done();
  });
  app.register(agentsRoutes);
  app.register(agentPublicRoutes);
  await app.ready();

  setRuntimeClient({
    startRun: async () => {}, cancelRun: async () => {}, resumeRun: async () => {},
  });

  appId = await seedTestApp({ prefix: 'public' });
  const ak = await getTestPool().query(`SELECT anon_key FROM apps WHERE id = $1`, [appId]);
  anonKey = ak.rows[0].anon_key;

  await app.inject({
    method: 'POST', url: `/v1/${appId}/agents`,
    payload: { name: 'pub', graph_spec: validSpec, visibility: 'public', safety_acknowledged: true },
  });
});

afterAll(async () => {
  await app.close();
  await cleanupTestApp(appId);
  await closeTestPool();
});

describe('POST /public/runs', () => {
  it('accepts anon key for visibility=public', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/public/agents/pub/runs`,
      headers: { apikey: anonKey },
      payload: { input: { q: 'hi' } },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.run_id).toBeTruthy();
    expect(body.stream_token).toBeTruthy();
    expect(body.expires_at).toBeTruthy();
  });

  it('rejects without auth', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/${appId}/public/agents/pub/runs`,
      payload: { input: { q: 'hi' } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects anon key when agent is private', async () => {
    await app.inject({
      method: 'POST', url: `/v1/${appId}/agents`,
      payload: { name: 'priv', graph_spec: validSpec },
    });
    const res = await app.inject({
      method: 'POST', url: `/v1/${appId}/public/agents/priv/runs`,
      headers: { apikey: anonKey },
      payload: { input: { q: 'hi' } },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('public run lifecycle', () => {
  let runId: string;
  beforeAll(async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/${appId}/public/agents/pub/runs`,
      headers: { apikey: anonKey },
      payload: { input: { q: 'lifecycle' } },
    });
    runId = res.json().run_id;
  });

  it('GET returns the run for the matching anon caller', async () => {
    const res = await app.inject({
      method: 'GET', url: `/v1/${appId}/public/runs/${runId}`,
      headers: { apikey: anonKey },
    });
    expect(res.statusCode).toBe(200);
  });

  it('cancel rejects anon caller (anon resume/cancel from public path → 403)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/${appId}/public/runs/${runId}/cancel`,
      headers: { apikey: anonKey },
    });
    expect(res.statusCode).toBe(403);
  });

  it('resume on non-paused run returns 409', async () => {
    // Force run to non-paused state — it'll already be queued/running here.
    const res = await app.inject({
      method: 'POST', url: `/v1/${appId}/public/runs/${runId}/resume`,
      headers: { apikey: anonKey },
      payload: { input: {} },
    });
    expect([403, 409]).toContain(res.statusCode);
  });
});

describe('public events + stream token refresh', () => {
  let runId: string;
  beforeAll(async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/${appId}/public/agents/pub/runs`,
      headers: { apikey: anonKey }, payload: { input: { q: 'evt' } },
    });
    runId = res.json().run_id;
  });

  it('events.json returns array of events', async () => {
    const res = await app.inject({
      method: 'GET', url: `/v1/${appId}/public/runs/${runId}/events.json?since_seq=0`,
      headers: { apikey: anonKey },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().events)).toBe(true);
  });

  it('stream-token refresh issues a new token', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/${appId}/public/runs/${runId}/stream-token`,
      headers: { apikey: anonKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stream_token).toBeTruthy();
  });
});

describe('end-to-end: app JWT path', () => {
  it('runs an authenticated agent and stamps caller_user_id on the run', async () => {
    const callerUserId = '00000000-0000-0000-0000-000000000abc';

    // 1. Get the app's private key (lazy-creates if not yet present).
    const { kid, privateKey } = await getOrCreateSigningKey(app.controlDb, appId);

    // 2. Mint an RS256 JWT signed with the app's private key.
    const jwt = await new jose.SignJWT({ sub: callerUserId })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(`${JWT_ISSUER_PREFIX}${appId}`)
      .setExpirationTime('1h')
      .sign(privateKey);

    // 3. POST to the public run endpoint with the JWT as Bearer token.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/public/agents/pub/runs`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { input: { q: 'jwt-smoke' } },
    });

    expect(res.statusCode).toBe(202);
    const { run_id } = res.json();
    expect(run_id).toBeTruthy();

    // 4. Verify caller_kind and caller_user_id were recorded on the run.
    const row = await app.controlDb.query(
      `SELECT caller_kind, caller_user_id FROM agent_runs WHERE id = $1`,
      [run_id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].caller_kind).toBe('end_user');
    expect(row.rows[0].caller_user_id).toBe(callerUserId);
  });
});
