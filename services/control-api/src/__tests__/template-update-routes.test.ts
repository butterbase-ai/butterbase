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
  releaseManifest?: { functions: { name: string }[] } | null;
  enqueueThrows?: boolean;
  createUpdateJobConflicts?: boolean;
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
        if (opts.enqueueThrows && /INSERT INTO neon_tasks/i.test(sql)) {
          throw new Error('queue unreachable');
        }
        return { rows: [] };
      },
    }),
  }));

  vi.doMock('../config.js', async () => ({ config: { runtimeDb: {}, s3: {} } }));

  // The undo route writes the repo "latest" pointer in S3 as well as the runtime
  // apps row — the update wrote both, so undo must put both back. Stubbed here so
  // the suite never reaches a real S3 client.
  const setLatestCalls: unknown[][] = [];
  vi.doMock('../services/repo-storage.js', async () => ({
    setLatest: async (...args: unknown[]) => { setLatestCalls.push(args); },
  }));

  const activeJob = opts.activeJob ?? null;
  const job = opts.job
    ? {
        id: opts.job.id,
        mode: opts.job.mode ?? 'update',
        status: opts.job.status,
        dest_app_id: opts.job.dest_app_id ?? 'app_fork',
        pre_sync_snapshot_id: opts.job.pre_sync_snapshot_id ?? null,
        pre_sync_lineage:
          opts.job.pre_sync_lineage === undefined ? null : opts.job.pre_sync_lineage,
        target_release_id: opts.job.target_release_id ?? 'rel_1',
        warnings: opts.job.warnings ?? [],
        error_message: opts.job.error_message ?? null,
        created_at: opts.job.created_at ?? new Date(),
        completed_at: opts.job.completed_at ?? null,
      }
    : null;

  const createUpdateJobCalls: Record<string, unknown>[] = [];
  const deletedJobIds: string[] = [];
  const actualCloneJobs = await vi.importActual<typeof import('../services/clone-jobs.js')>('../services/clone-jobs.js');
  vi.doMock('../services/clone-jobs.js', async () => ({
    getActiveUpdateJob: async () => activeJob,
    createUpdateJob: async (_db: unknown, args: Record<string, unknown>) => {
      createUpdateJobCalls.push(args);
      if (opts.createUpdateJobConflicts) {
        const { UpdateJobConflictError } = await import('../services/clone-jobs.js');
        throw new UpdateJobConflictError('app_fork');
      }
      return { id: 'cj_new', mode: 'update', status: 'pending', ...args };
    },
    UpdateJobConflictError: actualCloneJobs.UpdateJobConflictError,
    getCloneJob: async (_db: unknown, jobId: string) => (job && job.id === jobId ? job : null),
    deleteCloneJob: async (_db: unknown, jobId: string) => { deletedJobIds.push(jobId); },
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
  const controlWrites: { sql: string; params: unknown[] }[] = [];
  app.decorate('controlDb', {
    query: async (sql: string, params: unknown[] = []) => {
      controlWrites.push({ sql, params });
      if (/SELECT manifest FROM template_releases/i.test(sql)) {
        return { rows: [{ manifest: opts.releaseManifest ?? { functions: [] } }] };
      }
      return { rows: [] };
    },
  } as any);
  app.decorateRequest('auth', null as any);
  app.addHook('onRequest', async (request: any) => {
    request.auth = { userId: 'usr_1', organizationId: 'org_1', authMethod: 'session', scopes: ['*'] };
  });
  templateUpdateRoutes(app);

  return { app, recordedQueries, createUpdateJobCalls, deletedJobIds, setLatestCalls, controlWrites };
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


  // The pre-check (getActiveUpdateJob) is a read-then-write, so two concurrent
  // requests can both pass it. The partial unique index
  // idx_template_clone_jobs_one_update is what actually holds the line — but a
  // raw 23505 escaping the route surfaced to the owner as a 500
  // INTERNAL_ERROR. Double-clicking Update must read as "already in progress",
  // not as a server fault.
  it('returns 409, not 500, when the unique index rejects a racing insert', async () => {
    const { app } = await buildApp({ drift: { behind_by: 1 }, createUpdateJobConflicts: true });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/already in progress/i);
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

// ---------------------------------------------------------------------------
// The escape hatch. Undo used to move the repo pointer and nothing else, while
// the worker had already advanced app_lineage.base_snapshot_id — and
// computeDivergence is exactly `repo_latest_snapshot !== base_snapshot_id`. So
// undoing an update was what made a fork permanently ineligible and told its
// owner "You have changed this app." These tests pin the round trip.
// ---------------------------------------------------------------------------

import { decideEligibility } from '../services/template-update-eligibility.js';

const PRE_LINEAGE = {
  base_release_id: 'rel_6',
  base_snapshot_id: 'snap_prev',
  base_fingerprint: { hashes: { schema: 'a', rls: 'b', functions: 'c', config: 'd' } },
  manifest: {
    functions: [
      {
        name: 'fork_fn', code: 'export default () => 1', description: null,
        timeout_ms: 1000, memory_limit_mb: 128, agent_tool: false,
        agent_tool_description: null, agent_tool_mode: null, agent_tool_exposed_to: null,
        trigger_type: 'http', trigger_config: {},
      },
    ],
  },
};

/** The exact comparison computeDivergence makes, applied to what undo wrote. */
function repoDivergenceAfter(
  recordedQueries: { sql: string; params: unknown[] }[],
  controlWrites: { sql: string; params: unknown[] }[],
): boolean | null {
  const head = recordedQueries.find((q) => /UPDATE apps SET repo_latest_snapshot/i.test(q.sql));
  const lineage = controlWrites.find((q) => /UPDATE app_lineage/i.test(q.sql));
  if (!head || !lineage) return null;
  const repoHead = head.params[0];
  const baseSnapshot = lineage.params[1];
  return repoHead !== baseSnapshot;
}

describe('undo restores lineage, not just the repo pointer', () => {
  it('leaves the fork reading as UNMODIFIED, so it stays updatable', async () => {
    const { app, recordedQueries, controlWrites } = await buildApp({
      job: {
        id: 'cj_1', status: 'completed', mode: 'update',
        pre_sync_snapshot_id: 'snap_prev', pre_sync_lineage: PRE_LINEAGE,
      },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update/cj_1/undo' });
    expect(res.statusCode).toBe(200);
    expect(res.json().lineage_restored).toBe(true);

    const repo = repoDivergenceAfter(recordedQueries, controlWrites);
    expect(repo).toBe(false);

    // The whole point: the very next eligibility decision must not say 'modified'.
    const decision = decideEligibility(
      { is_fork: true, severed: false, source_app_id: 'app_src', behind_by: 1, releases: [] },
      { repo, frontend: false, schema: false, rls: false, functions: false,
        config: false, has_backend_base: true },
    );
    expect(decision.reason).not.toBe('modified');
    expect(decision).toEqual({ eligible: true, reason: 'ok' });
    await app.close();
  });

  it('restores all three lineage fields, NULLs included', async () => {
    // A live-cloned fork legitimately has base_release_id NULL; writing only
    // non-null fields would invent a lineage it never had.
    const { app, controlWrites } = await buildApp({
      job: {
        id: 'cj_1', status: 'completed', mode: 'update',
        pre_sync_snapshot_id: 'snap_prev',
        pre_sync_lineage: { ...PRE_LINEAGE, base_release_id: null },
      },
    });
    await app.inject({ method: 'POST', url: '/v1/app_fork/template/update/cj_1/undo' });
    const lineage = controlWrites.find((q) => /UPDATE app_lineage/i.test(q.sql))!;
    expect(lineage.params[0]).toBe(null);
    expect(lineage.params[1]).toBe('snap_prev');
    expect(lineage.params[2]).toContain('hashes');
    await app.close();
  });

  it('puts the S3 latest pointer back too, not only the apps row', async () => {
    const { app, setLatestCalls } = await buildApp({
      job: {
        id: 'cj_1', status: 'completed', mode: 'update',
        pre_sync_snapshot_id: 'snap_prev', pre_sync_lineage: PRE_LINEAGE,
      },
    });
    await app.inject({ method: 'POST', url: '/v1/app_fork/template/update/cj_1/undo' });
    expect(setLatestCalls).toEqual([['app_fork', 'snap_prev']]);
    await app.close();
  });

  it('writes lineage LAST, after the state it describes is actually back', async () => {
    const { app, recordedQueries, controlWrites } = await buildApp({
      job: {
        id: 'cj_1', status: 'completed', mode: 'update',
        pre_sync_snapshot_id: 'snap_prev', pre_sync_lineage: PRE_LINEAGE,
      },
    });
    await app.inject({ method: 'POST', url: '/v1/app_fork/template/update/cj_1/undo' });
    // The runtime writes (functions, repo head) all happen before the control
    // plane declares the fork clean.
    expect(recordedQueries.some((q) => /INSERT INTO app_functions/i.test(q.sql))).toBe(true);
    const lineageIdx = controlWrites.findIndex((q) => /UPDATE app_lineage/i.test(q.sql));
    expect(lineageIdx).toBeGreaterThanOrEqual(0);
    expect(controlWrites.slice(lineageIdx + 1).some((q) => /UPDATE apps/i.test(q.sql))).toBe(false);
    await app.close();
  });

  it('restores function bodies and withdraws the ones the release added', async () => {
    const { app, recordedQueries } = await buildApp({
      job: {
        id: 'cj_1', status: 'completed', mode: 'update',
        pre_sync_snapshot_id: 'snap_prev', pre_sync_lineage: PRE_LINEAGE,
        target_release_id: 'rel_7',
      },
      releaseManifest: { functions: [{ name: 'fork_fn' }, { name: 'new_template_fn' }] },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update/cj_1/undo' });
    expect(res.statusCode).toBe(200);

    const restore = recordedQueries.find((q) => /INSERT INTO app_functions/i.test(q.sql))!;
    expect(restore.params).toContain('export default () => 1');
    expect(restore.sql).toMatch(/deleted_at = NULL/);

    // Only the function the release ADDED is withdrawn — never one the owner wrote.
    const remove = recordedQueries.find((q) => /UPDATE app_functions SET deleted_at/i.test(q.sql))!;
    expect(remove.params[1]).toEqual(['new_template_fn']);
    await app.close();
  });
});

describe('undo on a FAILED update — the only exit left when one bricks a fork', () => {
  // executeUpdate publishes the repo before schema/functions/config/lineage, so
  // a throw in any later step leaves the fork on the template's code with its
  // own old lineage. POST /update then 422s ('modified'), retry 400s after an
  // hour, and undo used to 409 because the job was not 'completed'. All three
  // exits closed, on a live app.
  it('is permitted when the failed job carries pre-sync state', async () => {
    const { app, recordedQueries, controlWrites } = await buildApp({
      job: {
        id: 'cj_1', status: 'failed', mode: 'update',
        pre_sync_snapshot_id: 'snap_prev', pre_sync_lineage: PRE_LINEAGE,
      },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update/cj_1/undo' });
    expect(res.statusCode).toBe(200);
    expect(repoDivergenceAfter(recordedQueries, controlWrites)).toBe(false);
    await app.close();
  });

  it('is still refused on a failed job that never wrote anything', async () => {
    const { app } = await buildApp({
      job: { id: 'cj_1', status: 'failed', mode: 'update', pre_sync_snapshot_id: null },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update/cj_1/undo' });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('is still refused while a worker may be mid-write', async () => {
    for (const status of ['pending', 'processing', 'replaying_functions']) {
      const { app } = await buildApp({
        job: {
          id: 'cj_1', status, mode: 'update',
          pre_sync_snapshot_id: 'snap_prev', pre_sync_lineage: PRE_LINEAGE,
        },
      });
      const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update/cj_1/undo' });
      expect(res.statusCode).toBe(409);
      await app.close();
    }
  });
});

describe('POST /update compensates a failed enqueue', () => {
  // An un-enqueued 'pending' job is not a harmless orphan: getActiveUpdateJob
  // reads it as in flight, so it would 409 every future update of this fork
  // forever, with no worker ever coming to move it out of 'pending'.
  it('deletes the job row rather than stranding the fork on a phantom job', async () => {
    const { app, deletedJobIds } = await buildApp({
      drift: { behind_by: 1 },
      enqueueThrows: true,
    });
    const res = await app.inject({ method: 'POST', url: '/v1/app_fork/template/update' });
    expect(res.statusCode).toBe(503);
    expect(deletedJobIds).toEqual(['cj_new']);
    await app.close();
  });
});
