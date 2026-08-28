import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// This file intentionally does NOT import a `./helpers/test-app.js` harness —
// no such helper exists in this codebase. It follows the pattern already
// established in template-releases-routes.test.ts: vi.doMock the service
// modules per test, then build a fresh inline Fastify() instance.

interface DriftOpts {
  is_fork?: boolean;
  severed?: boolean;
  source_app_id?: string | null;
  behind_by?: number;
  releases?: { release_number: number; label: string | null; notes: string | null; published_at: Date }[];
}

function makeDrift(opts: DriftOpts = {}) {
  const behindBy = opts.behind_by ?? 0;
  const releases = opts.releases ?? (
    behindBy > 0
      ? Array.from({ length: behindBy }, (_, i) => ({
          release_number: behindBy - i + 1, // descending, highest first
          label: null, notes: null, published_at: new Date(),
        }))
      : []
  );
  return {
    is_fork: opts.is_fork ?? true,
    severed: opts.severed ?? false,
    source_app_id: opts.source_app_id ?? 'app_src',
    behind_by: behindBy,
    releases,
  };
}

function makeDivergence(overrides: Record<string, unknown> = {}) {
  return {
    repo: false, frontend: false, schema: false, rls: false,
    functions: false, config: false, has_backend_base: true,
    ...overrides,
  };
}

/**
 * Wires up the mocked service graph for the template-update routes and
 * returns a ready-to-inject Fastify instance. `recordedQueries` captures
 * every runtime-pool query so undo tests can assert on it directly, standing
 * in for the fictional `app.lastRepoHeadWrite` from the brief.
 */
async function buildApp(opts: {
  drift?: DriftOpts;
  divergence?: Record<string, unknown> | null;
  activeJob?: { id: string } | null;
  job?: {
    id: string; status: string; mode?: string; dest_app_id?: string;
    pre_sync_snapshot_id?: string | null; target_release_id?: string | null;
    warnings?: string[] | null; error_message?: string | null;
    created_at?: Date; completed_at?: Date | null;
  } | null;
  release?: { id: string; snapshot_id: string; release_number: number } | null;
}) {
  vi.resetModules();

  const recordedQueries: { sql: string; params: unknown[] }[] = [];

  vi.doMock('../services/app-resolver.js', async () => ({
    AppResolver: {
      resolveApp: async () => ({
        id: 'app_fork', name: 'fork', owner_id: 'usr_1',
        db_name: 'db_fork', paused: false, paused_reason: null,
      }),
    },
    AppNotFoundError: class extends Error {},
  }));

  const drift = makeDrift(opts.drift);
  vi.doMock('../services/app-lineage.js', async () => ({
    computeDrift: async () => drift,
    computeDivergence: async () => (opts.divergence === undefined ? makeDivergence() : opts.divergence),
    getLineage: async () => ({
      dest_app_id: 'app_fork', dest_region: 'us-east-1',
      source_app_id: drift.source_app_id ?? 'app_src', source_region: 'us-east-1',
      base_release_id: null, base_fingerprint: null, base_snapshot_id: null,
      severed_at: null, cloned_at: new Date(),
    }),
  }));

  vi.doMock('../services/region-resolver.js', async () => ({
    getRuntimeDbForApp: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        recordedQueries.push({ sql, params });
        return { rows: [] };
      },
    }),
  }));

  vi.doMock('../services/app-pool.js', async () => ({
    getAppPoolForApp: async () => ({ query: async () => ({ rows: [] }) }),
  }));

  vi.doMock('../services/runtime-db.js', async () => ({
    getRuntimeDbPool: () => ({
      query: async (sql: string, params: unknown[] = []) => {
        recordedQueries.push({ sql, params });
        return { rows: [] };
      },
    }),
  }));

  vi.doMock('../config.js', async () => ({ config: { runtimeDb: {} } }));

  const activeJob = opts.activeJob ?? null;
  const job = opts.job
    ? {
        id: opts.job.id,
        mode: opts.job.mode ?? 'update',
        status: opts.job.status,
        dest_app_id: opts.job.dest_app_id ?? 'app_fork',
        pre_sync_snapshot_id: opts.job.pre_sync_snapshot_id ?? null,
        target_release_id: opts.job.target_release_id ?? 'rel_1',
        warnings: opts.job.warnings ?? [],
        error_message: opts.job.error_message ?? null,
        created_at: opts.job.created_at ?? new Date(),
        completed_at: opts.job.completed_at ?? null,
      }
    : null;

  const createUpdateJobCalls: Record<string, unknown>[] = [];
  vi.doMock('../services/clone-jobs.js', async () => ({
    getActiveUpdateJob: async () => activeJob,
    createUpdateJob: async (_db: unknown, args: Record<string, unknown>) => {
      createUpdateJobCalls.push(args);
      return { id: 'cj_new', mode: 'update', status: 'pending', ...args };
    },
    getCloneJob: async (_db: unknown, jobId: string) => (job && job.id === jobId ? job : null),
  }));

  const release = opts.release ?? { id: 'rel_1', snapshot_id: 'snap_target', release_number: drift.releases[0]?.release_number ?? 1 };
  vi.doMock('../services/template-releases.js', async () => ({
    getRelease: async () => release,
  }));

  vi.doMock('../services/audit/with-audit.js', async () => ({
    logFromRequest: () => {},
  }));

  const { templateUpdateRoutes } = await import('../routes/template-update.js');
  const app = Fastify();
  app.decorate('controlDb', { query: async () => ({ rows: [] }) } as any);
  app.decorateRequest('auth', null as any);
  app.addHook('onRequest', async (request: any) => {
    request.auth = { userId: 'usr_1', organizationId: 'org_1', authMethod: 'session', scopes: ['*'] };
  });
  templateUpdateRoutes(app);

  return { app, recordedQueries, createUpdateJobCalls };
}

describe('POST /v1/:app_id/template/update', () => {
  it('returns 422 with reason when the fork is modified', async () => {
    const { app } = await buildApp({
      drift: { behind_by: 1 },
      divergence: makeDivergence({ repo: true }),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_INVALID_SCHEMA');
    expect(res.json().error.message).toMatch(/modified/i);
    await app.close();
  });

  it('returns 422 when divergence is unknown', async () => {
    const { app } = await buildApp({
      drift: { behind_by: 1 },
      divergence: makeDivergence({ repo: null }),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/unknown/i);
    await app.close();
  });

  it('returns 409 when an update is already in flight', async () => {
    const { app } = await buildApp({
      drift: { behind_by: 1 },
      activeJob: { id: 'cj_x' },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update' });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('returns 202 and a job for an eligible fork', async () => {
    const { app } = await buildApp({ drift: { behind_by: 2 } });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update' });
    expect(res.statusCode).toBe(202);
    expect(res.json().job_id).toBeDefined();
    await app.close();
  });

  // Guards the invariant documented on createUpdateJob: preSyncSnapshotId MUST
  // be null at creation time, or the worker's execution-time eligibility gate
  // (which treats a non-null pre_sync_snapshot_id as "this job already
  // started") never runs for any job. The obvious, tempting regression is
  // pre-filling it with the fork's current snapshot — asserted with `=== null`
  // rather than a falsiness check so a route that passed e.g. '' or 0 by
  // mistake still fails this test, same as the modified-vs-unknown split above.
  it('creates the job with preSyncSnapshotId strictly null, never pre-filled', async () => {
    const { app, createUpdateJobCalls } = await buildApp({ drift: { behind_by: 2 } });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update' });
    expect(res.statusCode).toBe(202);
    expect(createUpdateJobCalls).toHaveLength(1);
    expect(createUpdateJobCalls[0].preSyncSnapshotId).toBe(null);
    await app.close();
  });
});

describe('GET /v1/:app_id/template/update/eligibility', () => {
  it('reports reason=current for an up-to-date fork', async () => {
    const { app } = await buildApp({ drift: { behind_by: 0 } });
    const res = await app.inject({ method: 'GET', url: '/v1/app_fork/template/update/eligibility' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ eligible: false, reason: 'current' });
    await app.close();
  });

  it('reports eligible=true for a behind, unmodified fork', async () => {
    const { app } = await buildApp({ drift: { behind_by: 1 } });
    const res = await app.inject({ method: 'GET', url: '/v1/app_fork/template/update/eligibility' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ eligible: true, reason: 'ok' });
    expect(res.json().target_release).toBeTruthy();
    await app.close();
  });
});

describe('GET /v1/:app_id/template/update/:job_id', () => {
  it('returns job status', async () => {
    const { app } = await buildApp({
      job: { id: 'cj_1', status: 'processing', mode: 'update' },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/app_fork/template/update/cj_1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ job_id: 'cj_1', status: 'processing' });
    await app.close();
  });

  it('404s a job that does not belong to this fork', async () => {
    const { app } = await buildApp({
      job: { id: 'cj_1', status: 'processing', mode: 'update', dest_app_id: 'app_other' },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/app_fork/template/update/cj_1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /v1/:app_id/template/update/:job_id/undo', () => {
  it('restores the pre-sync snapshot as the fork repo HEAD', async () => {
    const { app, recordedQueries } = await buildApp({
      job: { id: 'cj_1', status: 'completed', mode: 'update', pre_sync_snapshot_id: 'snap_prev' },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update/cj_1/undo' });
    expect(res.statusCode).toBe(200);

    // Stand-in for the brief's fictional `app.lastRepoHeadWrite`: assert on
    // the actual query issued against the mocked runtime pool.
    const write = recordedQueries.find((q) => /UPDATE apps SET repo_latest_snapshot/i.test(q.sql));
    expect(write).toBeDefined();
    expect(write!.params).toEqual(['snap_prev', 'app_fork']);

    // Must issue no DDL — schema is forward-only.
    expect(recordedQueries.some((q) => /ALTER TABLE|CREATE TABLE|DROP TABLE/i.test(q.sql))).toBe(false);
    await app.close();
  });

  it('refuses to undo a job that has not completed', async () => {
    const { app } = await buildApp({
      job: { id: 'cj_1', status: 'processing', mode: 'update', pre_sync_snapshot_id: 'snap_prev' },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update/cj_1/undo' });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  // A job that predates the pre-sync capture, or a clone-mode job, has nothing to restore.
  it('refuses when there is no pre-sync snapshot', async () => {
    const { app } = await buildApp({
      job: { id: 'cj_1', status: 'completed', mode: 'update', pre_sync_snapshot_id: null },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update/cj_1/undo' });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('404s an undo for a job that is not mode=update', async () => {
    const { app } = await buildApp({
      job: { id: 'cj_1', status: 'completed', mode: 'clone', pre_sync_snapshot_id: 'snap_prev' },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update/cj_1/undo' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
