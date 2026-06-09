import { describe, it, expect, vi } from 'vitest';

describe('GET /v1/clone-jobs/:job_id — warnings field', () => {
  it('round-trips warnings from the JSONB column', async () => {
    const controlDbMock = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          id: 'cj_abc', status: 'completed',
          source_app_id: 'app_src', dest_app_id: 'app_dst',
          retry_count: 0, error_message: null,
          warnings: ['RLS policy "row_policy" references missing function get_user_id; skipped'],
          requested_by_user_id: 'usr_x',
          created_at: new Date('2026-06-01T00:00:00Z'),
          completed_at: new Date('2026-06-01T00:05:00Z'),
        }],
      }),
    };
    const { getCloneJob } = await import('../services/clone-jobs.js');
    const job = await getCloneJob(controlDbMock as any, 'cj_abc');
    expect(job?.warnings).toEqual(['RLS policy "row_policy" references missing function get_user_id; skipped']);
  });

  it('coerces null warnings to []', async () => {
    const controlDbMock = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          id: 'cj_no_warn', status: 'completed',
          source_app_id: 'app_src', dest_app_id: 'app_dst',
          retry_count: 0, error_message: null, warnings: null,
          requested_by_user_id: 'usr_x',
          created_at: new Date(), completed_at: new Date(),
        }],
      }),
    };
    const { getCloneJob } = await import('../services/clone-jobs.js');
    const job = await getCloneJob(controlDbMock as any, 'cj_no_warn');
    expect((job?.warnings ?? []) as string[]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/templates/:source_app_id/clone — env_var_values + auto_mint_api_key
// ---------------------------------------------------------------------------

process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import Fastify from 'fastify';
import fp from 'fastify-plugin';
import { cloneRoutes } from '../routes/clone.js';

// Use vi.hoisted so mock factory closures can reference these before vi.fn() runs.
const { mockCreateCloneJob, mockRuntimePoolQuery } = vi.hoisted(() => ({
  mockCreateCloneJob: vi.fn(),
  mockRuntimePoolQuery: vi.fn(),
}));

vi.mock('../services/clone-jobs.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/clone-jobs.js')>();
  return {
    ...orig,
    createCloneJob: mockCreateCloneJob,
  };
});

vi.mock('../services/runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(() => ({ query: mockRuntimePoolQuery })),
}));

vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(async (_controlDb: unknown, appId: string) => {
    if (appId === 'app_unknown') {
      const { AppNotFoundError } = await import('../services/app-resolver.js');
      throw new AppNotFoundError(appId);
    }
    return { query: mockRuntimePoolQuery };
  }),
}));

vi.mock('../config.js', () => ({
  config: {
    runtimeDb: {},
    auth: { enabled: false, jwtSecret: 'test' },
    devOwnerId: 'usr_dev',
    cognito: {},
    ses: { region: 'us-east-1' },
  },
  assertRegionConfig: vi.fn(),
}));

// quota-enforcement imports email-service at module level which reads config.ses.
// Mock the whole plugin to avoid the side-effecting import chain.
vi.mock('../plugins/quota-enforcement.js', () => ({ default: { name: 'quota-enforcement' } }));
vi.mock('../services/auth/email-service.js', () => ({ sendBillingEmail: vi.fn() }));
vi.mock('../services/redis.js', () => ({ getRedisClient: vi.fn(() => null) }));
vi.mock('../services/app-plan-resolver.js', () => ({ getLimitsForApp: vi.fn(async () => ({ maxRequestsPerMin: 100 })) }));

// A fixed "good" source app row returned by the runtime pool query.
const GOOD_SRC_ROW = {
  id: 'app_src',
  visibility: 'public',
  region: 'us-east-1',
  repo_latest_snapshot: 'snap_001',
};

let testUserId: string | null = 'usr_requester';

async function buildCloneApp() {
  const app = Fastify({ logger: false });

  // controlDb stub: no inflight jobs, no name collision.
  const controlDbStub = {
    query: vi.fn(async (sql: string) => {
      // inflight cap check
      if (sql.includes('template_clone_jobs') && sql.includes('count')) {
        return { rows: [{ c: 0 }] };
      }
      // name collision check
      if (sql.includes('user_app_index')) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };

  app.register(fp(async (fastify) => { fastify.decorate('controlDb', controlDbStub); }));

  app.addHook('onRequest', (req, _reply, done) => {
    req.auth = { userId: testUserId, authMethod: 'api_key', scopes: ['*'] } as any;
    done();
  });

  app.register(cloneRoutes);
  await app.ready();
  return app;
}

describe('POST /v1/templates/:source_app_id/clone — new fields', () => {
  it('happy path: passes env_var_values and auto_mint_api_key to createCloneJob', async () => {
    const app = await buildCloneApp();

    // Runtime pool returns the source app row.
    mockRuntimePoolQuery.mockResolvedValueOnce({ rows: [GOOD_SRC_ROW] });

    mockCreateCloneJob.mockResolvedValueOnce({ id: 'cj_new', status: 'pending' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates/app_src/clone',
      payload: {
        env_var_values: { 'my-fn': { OPENAI_KEY: 'sk-test' } },
        auto_mint_api_key: [{ fn_name: 'my-fn', key: 'BUTTERBASE_API_KEY' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().job_id).toBe('cj_new');

    expect(mockCreateCloneJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pendingEnvVarValues: { 'my-fn': { OPENAI_KEY: 'sk-test' } },
        autoMintRequests: [{ fn_name: 'my-fn', key: 'BUTTERBASE_API_KEY' }],
      }),
    );

    await app.close();
  });

  it('returns 400 when env_var_values is an array (invalid shape)', async () => {
    const app = await buildCloneApp();

    // Runtime pool returns the source app row.
    mockRuntimePoolQuery.mockResolvedValueOnce({ rows: [GOOD_SRC_ROW] });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates/app_src/clone',
      payload: { env_var_values: ['not', 'an', 'object'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_INVALID_SCHEMA');

    await app.close();
  });

  it('returns 400 when env_var_values has a non-object fn entry', async () => {
    const app = await buildCloneApp();

    mockRuntimePoolQuery.mockResolvedValueOnce({ rows: [GOOD_SRC_ROW] });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates/app_src/clone',
      payload: { env_var_values: { 'my-fn': 'not-an-object' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_INVALID_SCHEMA');

    await app.close();
  });

  it('returns 400 when auto_mint_api_key is not an array', async () => {
    const app = await buildCloneApp();

    mockRuntimePoolQuery.mockResolvedValueOnce({ rows: [GOOD_SRC_ROW] });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates/app_src/clone',
      payload: { auto_mint_api_key: { fn_name: 'my-fn', key: 'BUTTERBASE_API_KEY' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_INVALID_SCHEMA');

    await app.close();
  });

  it('returns 400 when auto_mint_api_key entry is missing key field', async () => {
    const app = await buildCloneApp();

    mockRuntimePoolQuery.mockResolvedValueOnce({ rows: [GOOD_SRC_ROW] });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates/app_src/clone',
      payload: { auto_mint_api_key: [{ fn_name: 'my-fn' }] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_INVALID_SCHEMA');

    await app.close();
  });

  it('omitting both new fields still succeeds (backward compat)', async () => {
    const app = await buildCloneApp();

    mockRuntimePoolQuery.mockResolvedValueOnce({ rows: [GOOD_SRC_ROW] });
    mockCreateCloneJob.mockResolvedValueOnce({ id: 'cj_legacy', status: 'pending' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates/app_src/clone',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().job_id).toBe('cj_legacy');

    expect(mockCreateCloneJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pendingEnvVarValues: undefined,
        autoMintRequests: undefined,
      }),
    );

    await app.close();
  });
});
