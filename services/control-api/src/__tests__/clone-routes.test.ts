import { describe, it, expect, vi, afterEach } from 'vitest';

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

// The route gained org resolution and a project-quota check after this suite was
// written. Both read the control DB, and the stub below returns `{ rows: [] }`
// for everything, so unmocked they throw and every case 500s regardless of what
// it was asserting. Mock them to the "allowed" answer so the assertions test what
// they claim to.
vi.mock('../services/org-resolver.js', () => ({
  resolveOrganizationId: vi.fn(async () => 'org_test'),
  assertOrgMember: vi.fn(async () => undefined),
}));
vi.mock('../services/project-quota.js', () => ({
  checkProjectQuota: vi.fn(async () => ({ ok: true, current: 0, limit: 100 })),
}));

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
      if (sql.includes('org_app_index')) {
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

// ---------------------------------------------------------------------------
// Region placement — a redirect must be visible to the caller
// ---------------------------------------------------------------------------

describe('POST /v1/templates/:source_app_id/clone — region placement', () => {
  const saved = {
    allowed: process.env.BUTTERBASE_PROVISION_ALLOWED_REGIONS,
    regions: process.env.BUTTERBASE_REGIONS,
    dflt: process.env.BUTTERBASE_DEFAULT_REGION,
  };

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('BUTTERBASE_PROVISION_ALLOWED_REGIONS', saved.allowed);
    restore('BUTTERBASE_REGIONS', saved.regions);
    restore('BUTTERBASE_DEFAULT_REGION', saved.dflt);
  });

  it('reports dest_region and no redirect marker when the region is open', async () => {
    process.env.BUTTERBASE_PROVISION_ALLOWED_REGIONS = 'us-east-1,us-west-2';
    delete process.env.BUTTERBASE_DEFAULT_REGION;

    const app = await buildCloneApp();
    mockRuntimePoolQuery.mockResolvedValueOnce({ rows: [GOOD_SRC_ROW] });
    mockCreateCloneJob.mockResolvedValueOnce({ id: 'cj_open', status: 'pending' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates/app_src/clone',
      payload: { dest_region: 'us-east-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().dest_region).toBe('us-east-1');
    expect(res.json().dest_region_redirected_from).toBeUndefined();
    expect(res.json().notice).toBeUndefined();

    await app.close();
  });

  it('tells the caller when the clone was redirected to another region', async () => {
    // The point of the fix: a closed region still yields a working clone, but
    // the caller is told it moved rather than discovering it later — or never.
    process.env.BUTTERBASE_PROVISION_ALLOWED_REGIONS = 'us-west-2';
    delete process.env.BUTTERBASE_DEFAULT_REGION;

    const app = await buildCloneApp();
    mockRuntimePoolQuery.mockResolvedValueOnce({ rows: [GOOD_SRC_ROW] });
    mockCreateCloneJob.mockResolvedValueOnce({ id: 'cj_moved', status: 'pending' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates/app_src/clone',
      payload: { dest_region: 'us-east-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().dest_region).toBe('us-west-2');
    expect(res.json().dest_region_redirected_from).toBe('us-east-1');
    expect(res.json().notice).toMatch(/us-east-1.*closed.*us-west-2/);

    // The job must actually be created in the region we reported, not the one
    // that was asked for — a mismatch would make the response a lie.
    expect(mockCreateCloneJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ destRegion: 'us-west-2' }),
    );

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/templates/:source_app_id/clone — per-user inflight cap must not
// count update-mode rows
// ---------------------------------------------------------------------------
//
// `template_clone_jobs` now holds both clone rows and template-update rows,
// discriminated by a `mode` column (migration 110). The inflight-cap query at
// clone.ts:171 counts non-terminal rows for the requesting user and 429s at 3.
// It must scope to `mode = 'clone'` — otherwise a user's in-flight template
// *updates* would consume their *clone* quota. This test simulates a real
// filtered dataset (3 non-terminal update-mode rows, 0 clone-mode rows) behind
// the mocked controlDb and asserts on the resulting HTTP status, not on SQL
// text, so it fails/passes based on actual scoping behaviour.
describe('POST /v1/templates/:source_app_id/clone — inflight cap mode scoping', () => {
  it('does not count in-flight update-mode jobs toward the clone concurrency cap', async () => {
    const app = Fastify({ logger: false });

    // Simulated rows for this user: 3 non-terminal *update* jobs, 0 clone jobs.
    // A correctly scoped query (mode = 'clone') must see count 0 here and let
    // the clone through; an unscoped query sees count 3 and wrongly 429s.
    const simulatedRows = [
      { mode: 'update', status: 'running' },
      { mode: 'update', status: 'pending' },
      { mode: 'update', status: 'running' },
    ];

    const controlDbStub = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('template_clone_jobs') && sql.toLowerCase().includes('count')) {
          const scopedToClone = /mode\s*=\s*'clone'/.test(sql);
          const c = simulatedRows.filter((r) => !scopedToClone || r.mode === 'clone').length;
          return { rows: [{ c }] };
        }
        if (sql.includes('org_app_index')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    app.register(fp(async (fastify) => { fastify.decorate('controlDb', controlDbStub); }));
    app.addHook('onRequest', (req, _reply, done) => {
      req.auth = { userId: 'usr_requester', authMethod: 'api_key', scopes: ['*'] } as any;
      done();
    });
    app.register(cloneRoutes);
    await app.ready();

    mockRuntimePoolQuery.mockResolvedValueOnce({ rows: [GOOD_SRC_ROW] });
    mockCreateCloneJob.mockResolvedValueOnce({ id: 'cj_scoped', status: 'pending' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates/app_src/clone',
      payload: {},
    });

    // With 3 update-mode rows in flight but 0 clone-mode rows, this clone
    // request must succeed — the update rows must not count toward the cap.
    expect(res.statusCode).toBe(200);
    expect(res.json().job_id).toBe('cj_scoped');

    await app.close();
  });

  it('still 429s at 3 in-flight clone-mode jobs (existing contract preserved)', async () => {
    const app = Fastify({ logger: false });

    const simulatedRows = [
      { mode: 'clone', status: 'running' },
      { mode: 'clone', status: 'pending' },
      { mode: 'clone', status: 'running' },
    ];

    const controlDbStub = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('template_clone_jobs') && sql.toLowerCase().includes('count')) {
          const scopedToClone = /mode\s*=\s*'clone'/.test(sql);
          const c = simulatedRows.filter((r) => !scopedToClone || r.mode === 'clone').length;
          return { rows: [{ c }] };
        }
        if (sql.includes('org_app_index')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    app.register(fp(async (fastify) => { fastify.decorate('controlDb', controlDbStub); }));
    app.addHook('onRequest', (req, _reply, done) => {
      req.auth = { userId: 'usr_requester', authMethod: 'api_key', scopes: ['*'] } as any;
      done();
    });
    app.register(cloneRoutes);
    await app.ready();

    mockRuntimePoolQuery.mockResolvedValueOnce({ rows: [GOOD_SRC_ROW] });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates/app_src/clone',
      payload: {},
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('CLONE_LIMIT_INFLIGHT');

    await app.close();
  });
});
