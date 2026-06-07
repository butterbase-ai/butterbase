// Must be set before any service module that reads AUTH_ENCRYPTION_KEY is loaded.
process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-token';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { internalAgentToolsRoutes } from '../routes/internal-agent-tools.js';

// ---------------------------------------------------------------------------
// Mock the builtin dispatcher so we don't need a live data-plane DB
// ---------------------------------------------------------------------------
vi.mock('../services/agent-tools/builtin-dispatcher.js', () => ({
  dispatchBuiltin: vi.fn(async (toolName: string) => {
    if (toolName === 'query_table') {
      return { ok: true, result: { rows: [{ id: 'row-1' }], row_count: 1 } };
    }
    return { ok: false, error: `unknown builtin tool: ${toolName}` };
  }),
}));

// ---------------------------------------------------------------------------
// Mock invokeFunction so we don't need a live Deno runtime
// ---------------------------------------------------------------------------
vi.mock('../services/function-invoke.js', () => ({
  invokeFunction: vi.fn(async () => ({
    ok: true,
    status_code: 200,
    result: { message: 'hello from function' },
  })),
}));

const TOKEN = 'test-internal-token';
const VALID_RUN_ID = '00000000-0000-0000-0000-000000000001';

const app = Fastify({ logger: false });

beforeAll(async () => {
  app.register(databasePlugin);
  app.register(internalAgentToolsRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------
describe('authentication', () => {
  it('returns 401 when x-internal-service-token header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent-tools/builtin/query_table',
      payload: {
        app_id: 'app_test',
        run_id: VALID_RUN_ID,
        caller_kind: 'dashboard',
        caller_user_id: null,
        args: { table: 'items' },
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when x-internal-service-token header has wrong value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent-tools/builtin/query_table',
      headers: { 'x-internal-service-token': 'wrong-token' },
      payload: {
        app_id: 'app_test',
        run_id: VALID_RUN_ID,
        caller_kind: 'dashboard',
        caller_user_id: null,
        args: { table: 'items' },
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Builtin dispatch — happy path
// ---------------------------------------------------------------------------
describe('POST /internal/agent-tools/builtin/:tool_name', () => {
  it('dispatches query_table and returns 200 with result', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent-tools/builtin/query_table',
      headers: { 'x-internal-service-token': TOKEN },
      payload: {
        app_id: 'app_test',
        run_id: VALID_RUN_ID,
        caller_kind: 'dashboard',
        caller_user_id: null,
        args: { table: 'items', limit: 10 },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.result.rows).toHaveLength(1);
  });

  it('returns 400 for an unknown builtin tool', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent-tools/builtin/nonexistent_tool',
      headers: { 'x-internal-service-token': TOKEN },
      payload: {
        app_id: 'app_test',
        run_id: VALID_RUN_ID,
        caller_kind: 'dashboard',
        caller_user_id: null,
        args: {},
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/unknown builtin tool/);
  });

  it('returns 400 when run_id is not a valid UUID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent-tools/builtin/query_table',
      headers: { 'x-internal-service-token': TOKEN },
      payload: {
        app_id: 'app_test',
        run_id: 'not-a-uuid',
        caller_kind: 'dashboard',
        caller_user_id: null,
        args: {},
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when caller_kind is invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent-tools/builtin/query_table',
      headers: { 'x-internal-service-token': TOKEN },
      payload: {
        app_id: 'app_test',
        run_id: VALID_RUN_ID,
        caller_kind: 'alien',
        caller_user_id: null,
        args: {},
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// function-invoke — happy path
// ---------------------------------------------------------------------------
describe('POST /internal/agent-tools/function-invoke', () => {
  it('invokes a function and returns 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent-tools/function-invoke',
      headers: { 'x-internal-service-token': TOKEN },
      payload: {
        app_id: 'app_test',
        run_id: VALID_RUN_ID,
        caller_kind: 'end_user',
        caller_user_id: 'user-123',
        function_name: 'my-function',
        args: { foo: 'bar' },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.result.message).toBe('hello from function');
  });

  it('returns 401 without token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent-tools/function-invoke',
      payload: {
        app_id: 'app_test',
        run_id: VALID_RUN_ID,
        caller_kind: 'dashboard',
        caller_user_id: null,
        function_name: 'my-function',
        args: {},
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when function_name is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/agent-tools/function-invoke',
      headers: { 'x-internal-service-token': TOKEN },
      payload: {
        app_id: 'app_test',
        run_id: VALID_RUN_ID,
        caller_kind: 'dashboard',
        caller_user_id: null,
        args: {},
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
