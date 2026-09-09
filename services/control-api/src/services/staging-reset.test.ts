/**
 * executeStagingReset re-seeds a staging app from PRODUCTION — the one job in
 * this feature whose direction is reversed from every other (promote, update,
 * clone all flow staging -> production; reset flows production -> staging).
 *
 * Two independent hazards, both destructive and unrecoverable, are tested
 * here:
 *   - replaySeedData's pool argument order (an insert-direction hazard: swap
 *     it and staging's stale rows overwrite production's).
 *   - the TRUNCATE this file adds (fix round 1): a truncate aimed at the
 *     source pool would destroy a customer's live production data. The
 *     'truncates ONLY the staging pool, never production' test below is the
 *     one that matters most in this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEnvironmentLink: vi.fn(),
  touchEnvironmentTimestamp: vi.fn(),
  replaySeedData: vi.fn(),
  /**
   * KEPT DELIBERATELY, THOUGH staging-reset.ts NO LONGER CALLS IT.
   *
   * This is the seam the truncate used to derive its table set from, and the
   * reason defect 1 shipped: `_seed_tables` is populated only from DSL tables
   * flagged `_seed: true`, so it is EMPTY for a normal app — and every test in
   * this file used to stub it with real table names, so the empty case (the
   * only one that occurs in production) was never exercised. It now defaults
   * to `[]`, the true production value. Any test below that passes while this
   * returns `[]` is a test the OLD implementation would have failed, because
   * the old implementation would have found nothing to truncate.
   */
  getSeedTableNames: vi.fn(),
  introspectSchema: vi.fn(),
  reconcileStagingSchema: vi.fn(),
  isolateStagingApp: vi.fn(),
  isolateStagingMeetingsWebhook: vi.fn(),
  setCloneJobStatus: vi.fn(),
  createCloneJob: vi.fn(),
  deleteCloneJob: vi.fn(),
  appendCloneJobWarnings: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
  getActivePromoteJob: vi.fn(),
  enqueueStagingDataCopy: vi.fn(),
  enqueueCopyWaitTask: vi.fn(),
}));

vi.mock('./app-environments.js', () => ({
  getEnvironmentLink: mocks.getEnvironmentLink,
  touchEnvironmentTimestamp: mocks.touchEnvironmentTimestamp,
}));
vi.mock('./clone-replay.js', () => ({
  replaySeedData: mocks.replaySeedData,
  getSeedTableNames: mocks.getSeedTableNames,
}));
vi.mock('./staging-isolation.js', () => ({
  isolateStagingApp: mocks.isolateStagingApp,
  isolateStagingMeetingsWebhook: mocks.isolateStagingMeetingsWebhook,
}));
vi.mock('./clone-jobs.js', () => ({
  setCloneJobStatus: mocks.setCloneJobStatus,
  createCloneJob: mocks.createCloneJob,
  deleteCloneJob: mocks.deleteCloneJob,
  appendCloneJobWarnings: mocks.appendCloneJobWarnings,
}));
vi.mock('./region-resolver.js', () => ({ getRuntimeDbForApp: mocks.getRuntimeDbForApp }));
vi.mock('./promote-jobs.js', () => ({ getActivePromoteJob: mocks.getActivePromoteJob }));
vi.mock('./staging-data-copy.js', () => ({
  enqueueStagingDataCopy: mocks.enqueueStagingDataCopy,
  enqueueCopyWaitTask: mocks.enqueueCopyWaitTask,
  COPY_POLL_INTERVAL_MS: 10_000,
}));
vi.mock('./schema-introspector.js', () => ({
  EXCLUDED_TABLES: ['_ai_migrations', '_data_plane_migrations', '_rag_collections',
    '_rag_documents', '_rag_chunks', '_idempotency_keys', '_seed_tables'],
  introspectSchema: mocks.introspectSchema,
}));
vi.mock('./staging-schema-reconcile.js', () => ({
  reconcileStagingSchema: mocks.reconcileStagingSchema,
}));

import { startStagingReset, executeStagingReset } from './staging-reset.js';

// job.source_app_id is PRODUCTION, job.dest_app_id is STAGING — the opposite
// of a promote job (source = staging, dest = production). This is the single
// most dangerous line in this test file: swap these two values and every
// assertion below still typechecks while describing the wrong app.
const job = {
  id: 'job_r1', mode: 'staging_reset', source_app_id: 'app_prod', dest_app_id: 'app_staging',
} as never;

const STAGING_DB_NAME = 'db_staging';

/**
 * Point the truncate's table set at `names`.
 *
 * The truncate is derived from `introspectSchema(stagingPool)` — the SAME
 * function the app-copy engine's `buildCopyPlan` uses for its own table list
 * (its `deps.introspect` is literally this import) — not from the
 * `_seed_tables` registry. Only `tables`'s KEYS matter here; the column detail
 * belongs to callers that diff schemas, which staging-reset.ts does not do
 * itself (reconcileStagingSchema, mocked separately, owns that).
 */
function setStagingTables(names: string[]): void {
  mocks.introspectSchema.mockResolvedValue({
    tables: Object.fromEntries(names.map((n) => [n, { columns: {} }])),
  });
}

/**
 * Point `reconcileStagingSchema` at a result.
 *
 * `destroyed` is the plain-language list of staging objects the reconcile
 * dropped or rewrote. Reset is entitled to destroy staging schema so that it
 * always succeeds; naming what it destroyed is the other half of that deal, so
 * the default is deliberately empty and a test that wants the disclosure asks
 * for it explicitly.
 */
function setReconcile(destroyed: string[] = []): void {
  mocks.reconcileStagingSchema.mockResolvedValue({ applied: [], destroyed });
}

/**
 * Fallback response for the staging pool's `SELECT current_database()`
 * (truncateStagingAppTables's Guard 3) — matches STAGING_DB_NAME so tests
 * that don't care about Guard 3 aren't tripped by it. Every test below that
 * replaces stagingPool.query wholesale with its own mockImplementation
 * delegates to this for anything it doesn't itself recognize, so Guard 3
 * keeps passing in tests exercising something else entirely.
 */
function defaultStagingQueryResponse(sql: unknown) {
  if (typeof sql === 'string' && /current_database/.test(sql)) {
    return { rows: [{ current_database: STAGING_DB_NAME }] };
  }
  return { rows: [] };
}

function makePool() {
  return { query: vi.fn().mockImplementation(async (sql: unknown) => defaultStagingQueryResponse(sql)) };
}

let prodPool: ReturnType<typeof makePool>;
let stagingPool: ReturnType<typeof makePool>;
let deps: {
  controlDb: never; runtimeDb: never;
  prodPool: never; stagingPool: never;
  stagingDbName: string;
  attempt: number; maxAttempts: number;
  logger: { info: () => void; warn: () => void; error: () => void };
};

beforeEach(() => {
  vi.clearAllMocks();
  prodPool = makePool();
  stagingPool = makePool();
  deps = {
    controlDb: {} as never,
    runtimeDb: {} as never,
    prodPool: prodPool as never,
    stagingPool: stagingPool as never,
    stagingDbName: STAGING_DB_NAME,
    // Single-attempt by default: most tests want a thrown error to go
    // terminal immediately. The attempt-gating tests below override these.
    attempt: 1,
    maxAttempts: 1,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  mocks.getRuntimeDbForApp.mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [{ region: 'us-east-1' }] }),
  });
  mocks.getActivePromoteJob.mockResolvedValue(null);
  mocks.getEnvironmentLink.mockResolvedValue({ staging_app_id: 'app_staging' });
  mocks.createCloneJob.mockResolvedValue({ id: 'job_r1' });
  mocks.setCloneJobStatus.mockResolvedValue(undefined);
  mocks.appendCloneJobWarnings.mockResolvedValue(undefined);
  // Real shape, not `undefined`: replaySeedData returns
  // { tables, rows, warnings } and soft-fails PER TABLE onto `warnings` rather
  // than throwing. The old `undefined` default is exactly what let the
  // dropped-return-value defect sit here unnoticed — nothing in this file
  // could observe a warning that was never modelled. Default matches the
  // introspectSchema default below so the two lists agree unless a test
  // deliberately diverges them.
  mocks.replaySeedData.mockResolvedValue({
    tables: ['widgets', 'orders'], rows: 12, warnings: [],
  });
  // THE PRODUCTION-TRUTHFUL DEFAULT: no table carries `_seed: true`, so
  // `_seed_tables` is empty. The old implementation derived the truncate set
  // from here and therefore truncated NOTHING for an app shaped like this.
  mocks.getSeedTableNames.mockResolvedValue([]);
  setStagingTables(['widgets', 'orders']);
  setReconcile();
  mocks.isolateStagingApp.mockResolvedValue(undefined);
  mocks.isolateStagingMeetingsWebhook.mockResolvedValue(undefined);
  mocks.touchEnvironmentTimestamp.mockResolvedValue(undefined);
});

describe('startStagingReset', () => {
  it('creates a reset job targeting the staging app', async () => {
    const controlDb = { query: vi.fn().mockResolvedValue({ rows: [] }) } as never;
    const res = await startStagingReset({
      controlDb, prodAppId: 'app_prod', userId: 'u1', orgId: 'org_1',
    });
    expect(res).toMatchObject({ ok: true, jobId: 'job_r1', stagingAppId: 'app_staging' });
  });

  it('refuses when there is no staging environment', async () => {
    mocks.getEnvironmentLink.mockResolvedValue(null);
    const res = await startStagingReset({
      controlDb: {} as never, prodAppId: 'app_prod', userId: 'u1', orgId: 'org_1',
    });
    expect(res).toMatchObject({ ok: false, code: 'NO_STAGING' });
  });

  it('creates the job with the PRODUCTION app as source, not staging', async () => {
    const controlDb = { query: vi.fn().mockResolvedValue({ rows: [] }) } as never;
    await startStagingReset({
      controlDb, prodAppId: 'app_prod', userId: 'u1', orgId: 'org_1',
    });
    expect(mocks.createCloneJob).toHaveBeenCalledWith(
      controlDb,
      expect.objectContaining({ sourceAppId: 'app_prod' }),
    );
  });

  // Fix round 3, item 2: a reset that truncates staging's seed tables while a
  // promote is reading them mid-flight lets that promote silently copy a
  // partial dataset onto production while reporting success. Refuse before
  // any side effect, the same shape as startPromote's own IN_FLIGHT check.
  it('refuses when a promote is in flight for this app, before any write', async () => {
    mocks.getActivePromoteJob.mockResolvedValue({ id: 'cj_promote_1' } as never);
    const controlDb = { query: vi.fn().mockResolvedValue({ rows: [] }) } as never;
    const res = await startStagingReset({
      controlDb, prodAppId: 'app_prod', userId: 'u1', orgId: 'org_1',
    });
    expect(res).toMatchObject({ ok: false, code: 'IN_FLIGHT' });
    expect(mocks.getEnvironmentLink).not.toHaveBeenCalled();
    expect(mocks.createCloneJob).not.toHaveBeenCalled();
  });

  it('proceeds when getActivePromoteJob reports nothing in flight', async () => {
    mocks.getActivePromoteJob.mockResolvedValue(null);
    const controlDb = { query: vi.fn().mockResolvedValue({ rows: [] }) } as never;
    const res = await startStagingReset({
      controlDb, prodAppId: 'app_prod', userId: 'u1', orgId: 'org_1',
    });
    expect(res).toMatchObject({ ok: true });
  });

  // THE TEST THAT FAILS WITHOUT THE FIX. Before this fix, startStagingReset
  // had no notion of a second reset in flight at all — a second request for
  // the same app sailed through to `ok: true` no matter what the first
  // reset's job row looked like. This is the request-time precheck
  // (getActiveResetJob), keyed on the STAGING app id since that is every
  // reset job's dest_app_id.
  it('refuses when another reset is already in flight for this app, before creating a job', async () => {
    const controlDb = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && /mode = 'staging_reset'/.test(sql)) {
          return { rows: [{ id: 'job_reset_prev' }] };
        }
        return { rows: [] };
      }),
    } as never;
    const res = await startStagingReset({
      controlDb, prodAppId: 'app_prod', userId: 'u1', orgId: 'org_1',
    });
    expect(res).toMatchObject({ ok: false, code: 'RESET_IN_FLIGHT' });
    expect(mocks.createCloneJob).not.toHaveBeenCalled();
  });

  it('proceeds when getActiveResetJob reports nothing in flight', async () => {
    const controlDb = { query: vi.fn().mockResolvedValue({ rows: [] }) } as never;
    const res = await startStagingReset({
      controlDb, prodAppId: 'app_prod', userId: 'u1', orgId: 'org_1',
    });
    expect(res).toMatchObject({ ok: true });
  });

  // The precheck above is a read-then-write, not an atomic guarantee — same
  // caveat as startPromote's own IN_FLIGHT precheck. This is the 23505 path:
  // idx_template_clone_jobs_one_reset (migration 120) is what actually
  // enforces "at most one in-flight reset per staging app", and this is where
  // a losing racer's UPDATE becomes visible to it as a unique violation.
  it('compensates for a lost race at the unique index: deletes the job and returns RESET_IN_FLIGHT', async () => {
    const dbError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505', constraint: 'idx_template_clone_jobs_one_reset',
    });
    const controlDb = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && /^\s*UPDATE template_clone_jobs/.test(sql)) {
          throw dbError;
        }
        return { rows: [] };
      }),
    } as never;
    const res = await startStagingReset({
      controlDb, prodAppId: 'app_prod', userId: 'u1', orgId: 'org_1',
    });
    expect(res).toMatchObject({ ok: false, code: 'RESET_IN_FLIGHT' });
    expect(mocks.deleteCloneJob).toHaveBeenCalledWith(controlDb, 'job_r1');
  });

  // Narrow catch, not blanket: an unrelated unique violation (or any other
  // error) at the same UPDATE must surface, not be swallowed as a false
  // RESET_IN_FLIGHT.
  it('rethrows a unique violation that is NOT idx_template_clone_jobs_one_reset', async () => {
    const otherError = Object.assign(new Error('some other constraint'), {
      code: '23505', constraint: 'template_clone_jobs_pkey',
    });
    const controlDb = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && /^\s*UPDATE template_clone_jobs/.test(sql)) {
          throw otherError;
        }
        return { rows: [] };
      }),
    } as never;
    await expect(startStagingReset({
      controlDb, prodAppId: 'app_prod', userId: 'u1', orgId: 'org_1',
    })).rejects.toThrow('some other constraint');
    expect(mocks.deleteCloneJob).not.toHaveBeenCalled();
  });
});

describe('executeStagingReset', () => {
  it('seeds staging from production, never the reverse', async () => {
    await executeStagingReset(deps as never, job);
    expect(mocks.replaySeedData).toHaveBeenCalledWith(
      deps.prodPool, deps.stagingPool, expect.anything(),
    );
  });

  it('fails loudly if the pools were swapped (direction regression guard)', async () => {
    // Sanity check on the test's own fixtures: prodPool and stagingPool must
    // be distinguishable objects, or the assertion above could pass by
    // accident even with the arguments reversed.
    expect(deps.prodPool).not.toBe(deps.stagingPool);
    await executeStagingReset(deps as never, job);
    const call = mocks.replaySeedData.mock.calls[0];
    expect(call[0]).toBe(prodPool);
    expect(call[1]).toBe(stagingPool);
    // A reversed call would have call[0] === stagingPool — assert the
    // negative explicitly so a future edit that swaps the arguments fails
    // this test even if someone loosens the assertion above.
    expect(call[0]).not.toBe(stagingPool);
    expect(call[1]).not.toBe(prodPool);
  });

  // The test that matters most in this file (fix round 1): a TRUNCATE aimed
  // at the wrong pool destroys a customer's live production data,
  // unrecoverably. This fails if a future edit ever routes the truncate at
  // prodPool instead of stagingPool.
  it('truncates ONLY the staging pool before re-seeding, never production', async () => {
    await executeStagingReset(deps as never, job);

    const truncateCalls = stagingPool.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /^TRUNCATE TABLE/i.test(c[0]),
    );
    expect(truncateCalls).toHaveLength(1);
    expect(truncateCalls[0][0]).toContain('"widgets"');
    expect(truncateCalls[0][0]).toContain('"orders"');

    // prodPool.query must never be called at all by executeStagingReset —
    // not for the truncate, not for its cascade-closure introspection.
    // replaySeedData (mocked) is the only thing that would ever legitimately
    // touch prodPool, and it never calls back into deps.prodPool.query here.
    expect(prodPool.query).not.toHaveBeenCalled();
  });

  it('derives the truncated table set by introspecting STAGING, not from a hardcoded list', async () => {
    setStagingTables(['custom_table']);
    await executeStagingReset(deps as never, job);
    expect(mocks.introspectSchema).toHaveBeenCalledWith(deps.stagingPool);
    const truncateCalls = stagingPool.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /^TRUNCATE TABLE/i.test(c[0]),
    );
    expect(truncateCalls[0][0]).toContain('"custom_table"');
  });

  /**
   * DEFECT 1 REGRESSION — the one that would have caught the live failure.
   *
   * `_seed_tables` is empty for every app whose DSL does not flag a table
   * `_seed: true`, i.e. essentially all of them. The previous implementation
   * derived the truncate set from that registry, logged "no seed-flagged
   * tables on staging; nothing to truncate", and let the purely additive
   * `INSERT ... ON CONFLICT DO NOTHING` copy that follows leave every drifted
   * staging row exactly as it was — while the job reported `completed`.
   *
   * The old tests could not see this because they all stubbed
   * `getSeedTableNames` with real table names. Here it returns `[]`, which is
   * what a real app returns, AND the staging database genuinely has rows: the
   * assertion is that a TRUNCATE still runs over the real tables. Against the
   * pre-fix implementation this test fails — no TRUNCATE is issued at all.
   */
  it('still truncates staging\'s real tables when _seed_tables is empty (the normal app)', async () => {
    mocks.getSeedTableNames.mockResolvedValue([]);
    setStagingTables(['notes', 'app_settings']);

    await executeStagingReset(deps as never, job);

    const truncateCalls = stagingPool.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /^TRUNCATE TABLE/i.test(c[0]),
    );
    expect(truncateCalls).toHaveLength(1);
    expect(truncateCalls[0][0]).toContain('"notes"');
    expect(truncateCalls[0][0]).toContain('"app_settings"');
    // And it must not have consulted the registry that was empty: the whole
    // point is that the derivation moved off it.
    expect(mocks.getSeedTableNames).not.toHaveBeenCalled();
  });

  // Fix round 3, item 3: the filter is structural, not an emergent property of
  // introspectSchema's own exclusion list staying where it is. If a
  // Butterbase bookkeeping table ever reached this list, truncateStagingAppTables
  // must still refuse to include it.
  it('excludes Butterbase-internal bookkeeping tables even if introspection returns one', async () => {
    setStagingTables(['widgets', '_rag_chunks', '_idempotency_keys']);
    await executeStagingReset(deps as never, job);
    const truncateCalls = stagingPool.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /^TRUNCATE TABLE/i.test(c[0]),
    );
    expect(truncateCalls).toHaveLength(1);
    expect(truncateCalls[0][0]).toContain('"widgets"');
    expect(truncateCalls[0][0]).not.toContain('_rag_chunks');
    expect(truncateCalls[0][0]).not.toContain('_idempotency_keys');
  });

  it('appends a job warning naming any table outside the list the cascade swept', async () => {
    // Simulate the real recursive CTE: the targeted names come back plus a
    // table ('audit_log') outside the list that has an FK into one of them.
    stagingPool.query.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && /WITH RECURSIVE targeted/.test(sql)) {
        return {
          rows: [
            { table_name: 'widgets' }, { table_name: 'orders' }, { table_name: 'audit_log' },
          ],
        };
      }
      return defaultStagingQueryResponse(sql);
    });
    await executeStagingReset(deps as never, job);
    expect(mocks.appendCloneJobWarnings).toHaveBeenCalledTimes(1);
    const [, , warnings] = mocks.appendCloneJobWarnings.mock.calls[0];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('audit_log');
  });

  // Anti-vacuity check: the warning must not fire when the cascade closure
  // never leaves the truncate list — otherwise every reset would carry a
  // permanent, meaningless warning.
  it('does NOT append a warning when nothing outside the truncate list was touched', async () => {
    stagingPool.query.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && /WITH RECURSIVE targeted/.test(sql)) {
        return { rows: [{ table_name: 'widgets' }, { table_name: 'orders' }] };
      }
      return defaultStagingQueryResponse(sql);
    });
    await executeStagingReset(deps as never, job);
    expect(mocks.appendCloneJobWarnings).not.toHaveBeenCalled();
  });

  it('does not fail the reset when the cascade-closure introspection query throws', async () => {
    stagingPool.query.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && /WITH RECURSIVE targeted/.test(sql)) {
        throw new Error('introspection boom');
      }
      return defaultStagingQueryResponse(sql);
    });
    await executeStagingReset(deps as never, job);
    // The truncate and the rest of the reset still ran.
    const truncateCalls = stagingPool.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /^TRUNCATE TABLE/i.test(c[0]),
    );
    expect(truncateCalls).toHaveLength(1);
    expect(mocks.replaySeedData).toHaveBeenCalled();
    expect(mocks.appendCloneJobWarnings).not.toHaveBeenCalled();
  });

  it('skips the truncate entirely when staging has no user tables at all', async () => {
    setStagingTables([]);
    await executeStagingReset(deps as never, job);
    const truncateCalls = stagingPool.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /^TRUNCATE TABLE/i.test(c[0]),
    );
    expect(truncateCalls).toHaveLength(0);
    expect(mocks.replaySeedData).toHaveBeenCalled();
  });

  // Fix round 4: the request-time IN_FLIGHT precheck (startStagingReset)
  // cannot see a promote that starts AFTER the reset was queued but BEFORE
  // its worker claimed the task — resets sit in the queue, so that ordering
  // is the realistic race. executeStagingReset re-checks right before the
  // truncate. The assertion that matters is that the truncate (and the
  // re-seed) never ran — not the exact status write.
  it('fails before any truncate or seed call when a promote is in flight at execution time', async () => {
    mocks.getActivePromoteJob.mockResolvedValue({ id: 'cj_promote_1' } as never);
    await expect(executeStagingReset(deps as never, job)).rejects.toThrow(
      /promote is now in flight/i,
    );
    expect(prodPool.query).not.toHaveBeenCalled();
    expect(stagingPool.query).not.toHaveBeenCalled();
    expect(mocks.replaySeedData).not.toHaveBeenCalled();
    expect(mocks.isolateStagingApp).not.toHaveBeenCalled();
  });

  it('is a permanent failure, not attempt-gated, when a promote is in flight at execution time', async () => {
    mocks.getActivePromoteJob.mockResolvedValue({ id: 'cj_promote_1' } as never);
    // Plenty of attempts remain — an attempt-gated failure would NOT mark
    // 'failed' here, but this one always should, since retrying into the
    // same conflict is pointless.
    const retryDeps = { ...deps, attempt: 1, maxAttempts: 5 };
    await expect(executeStagingReset(retryDeps as never, job)).rejects.toThrow(
      /promote is now in flight/i,
    );
    expect(mocks.setCloneJobStatus).toHaveBeenCalledWith(
      deps.controlDb, 'job_r1', expect.objectContaining({ status: 'failed' }),
    );
  });

  it('checks the CURRENT state of the promote job, not the request-time snapshot', async () => {
    // getActivePromoteJob is called once at execution time by
    // executeStagingReset itself — independent of whatever startStagingReset
    // saw (or didn't see) when the job was originally queued.
    await executeStagingReset(deps as never, job);
    expect(mocks.getActivePromoteJob).toHaveBeenCalledWith(deps.controlDb, 'app_prod');
  });

  it('hard-refuses before touching anything when dest_app_id equals the production app id', async () => {
    const malformedJob = {
      ...job, source_app_id: 'app_x', dest_app_id: 'app_x',
    } as never;
    await expect(executeStagingReset(deps as never, malformedJob)).rejects.toThrow(
      /refusing to reset/i,
    );
    expect(prodPool.query).not.toHaveBeenCalled();
    expect(stagingPool.query).not.toHaveBeenCalled();
    expect(mocks.replaySeedData).not.toHaveBeenCalled();
    expect(mocks.setCloneJobStatus).toHaveBeenCalledWith(
      deps.controlDb, 'job_r1', expect.objectContaining({ status: 'failed' }),
    );
  });

  // Guard 3 (fix round 3): the only guard that checks the LIVE connection
  // rather than a value threaded through arguments — see
  // truncateStagingAppTables's doc comment. This is what still catches a
  // swap of the two getAppPoolForApp calls in neon-task-worker.ts's
  // executeResetTask (covered end-to-end in
  // services/__tests__/execute-reset-task.test.ts); at this layer it is
  // exercised directly via a mismatched stagingDbName.
  it('refuses to truncate when the staging pool is connected to the wrong database', async () => {
    const mismatchedDeps = { ...deps, stagingDbName: 'db_someone_elses_app' };
    await expect(executeStagingReset(mismatchedDeps as never, job)).rejects.toThrow(
      /connected to database/i,
    );
    const truncateCalls = stagingPool.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /^TRUNCATE TABLE/i.test(c[0]),
    );
    expect(truncateCalls).toHaveLength(0);
  });

  it('refuses when the staging pool is reference-identical to the production pool', async () => {
    const samePool = makePool();
    const badDeps = { ...deps, prodPool: samePool as never, stagingPool: samePool as never };
    await expect(executeStagingReset(badDeps as never, job)).rejects.toThrow(
      /reference-identical/i,
    );
    expect(mocks.replaySeedData).not.toHaveBeenCalled();
  });

  it('re-applies isolation after truncate + re-seed, in real sequence', async () => {
    const order: string[] = [];
    stagingPool.query.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && /^TRUNCATE TABLE/i.test(sql)) order.push('truncate');
      return defaultStagingQueryResponse(sql);
    });
    mocks.replaySeedData.mockImplementation(async () => {
      order.push('seed');
      return { tables: ['widgets', 'orders'], rows: 1, warnings: [] };
    });
    mocks.isolateStagingApp.mockImplementation(async () => { order.push('isolate'); });
    mocks.isolateStagingMeetingsWebhook.mockImplementation(async () => { order.push('isolate-webhook'); });
    await executeStagingReset(deps as never, job);
    expect(order).toEqual(['truncate', 'seed', 'isolate', 'isolate-webhook']);
  });

  it('isolates the STAGING app id, not production', async () => {
    await executeStagingReset(deps as never, job);
    expect(mocks.isolateStagingApp).toHaveBeenCalledWith(deps.runtimeDb, 'app_staging');
    expect(mocks.isolateStagingMeetingsWebhook).toHaveBeenCalledWith(deps.controlDb, 'app_staging');
  });

  it('records the reset time keyed on the PRODUCTION app id', async () => {
    await executeStagingReset(deps as never, job);
    expect(mocks.touchEnvironmentTimestamp)
      .toHaveBeenCalledWith(deps.runtimeDb, 'app_prod', 'last_reset_at');
  });

  it('fails the job when seeding throws on the final attempt', async () => {
    mocks.replaySeedData.mockRejectedValueOnce(new Error('seed boom'));
    await expect(executeStagingReset(deps as never, job)).rejects.toThrow('seed boom');
    expect(mocks.setCloneJobStatus).toHaveBeenLastCalledWith(
      deps.controlDb, 'job_r1', expect.objectContaining({ status: 'failed' }),
    );
  });

  it('does NOT mark the job failed when attempts remain (matches executePromote/executeUpdate)', async () => {
    // Marking 'failed' on attempt 1 of 3 would make the two retries the
    // queue still owes silent no-ops — 'failed'/'completed' are the terminal
    // statuses a re-entry guard short-circuits on.
    mocks.replaySeedData.mockRejectedValueOnce(new Error('transient boom'));
    const retryDeps = { ...deps, attempt: 1, maxAttempts: 3 };
    await expect(executeStagingReset(retryDeps as never, job)).rejects.toThrow('transient boom');
    const statusCalls = mocks.setCloneJobStatus.mock.calls;
    const lastCall = statusCalls[statusCalls.length - 1];
    expect(lastCall[2]).not.toMatchObject({ status: 'failed' });
  });

  it('marks the job failed once the final attempt is exhausted', async () => {
    mocks.replaySeedData.mockRejectedValueOnce(new Error('final boom'));
    const finalDeps = { ...deps, attempt: 3, maxAttempts: 3 };
    await expect(executeStagingReset(finalDeps as never, job)).rejects.toThrow('final boom');
    expect(mocks.setCloneJobStatus).toHaveBeenLastCalledWith(
      deps.controlDb, 'job_r1', expect.objectContaining({ status: 'failed' }),
    );
  });
});

/**
 * The production data copy.
 *
 * Reset's own machinery only ever carried the _seed-flagged tables. Everything
 * else — every other table's rows, the auth users, the uploaded files — comes
 * from the app-copy engine, enqueued here and executed elsewhere. Two things
 * have to hold for that to be honest:
 *   - the reset job must NOT report completed while the copy is still running;
 *   - `last_reset_at` must not move until the reset it dates has happened.
 */
describe('executeStagingReset — production data copy', () => {
  function withRegion() {
    return { ...deps, region: 'us-east-1' } as never;
  }

  it('does not enqueue anything, and behaves exactly as before, without a region', async () => {
    setStagingTables(['orders']);
    await executeStagingReset(deps as never, job);
    expect(mocks.enqueueStagingDataCopy).not.toHaveBeenCalled();
    expect(mocks.setCloneJobStatus).toHaveBeenCalledWith(
      expect.anything(), 'job_r1', expect.objectContaining({ status: 'completed' }),
    );
  });

  it('parks the job in copying_data and does NOT complete it while the copy runs', async () => {
    setStagingTables(['orders']);
    mocks.enqueueStagingDataCopy.mockResolvedValue({ ok: true, copyJobId: 'ac_1' });

    await executeStagingReset(withRegion(), job);

    expect(mocks.setCloneJobStatus).toHaveBeenCalledWith(
      expect.anything(), 'job_r1',
      { status: 'copying_data', data_copy_job_id: 'ac_1' },
    );
    // The trap this whole design exists to avoid: a reset reporting done while
    // staging holds schema and seed rows only.
    const completed = mocks.setCloneJobStatus.mock.calls.filter(
      (c) => (c[2] as { status?: string })?.status === 'completed',
    );
    expect(completed).toHaveLength(0);
  });

  it('does not move last_reset_at until the copy has finished', async () => {
    setStagingTables(['orders']);
    mocks.enqueueStagingDataCopy.mockResolvedValue({ ok: true, copyJobId: 'ac_1' });
    await executeStagingReset(withRegion(), job);
    expect(mocks.touchEnvironmentTimestamp).not.toHaveBeenCalled();
  });

  it('arms a wait task on the STAGING app in the pair\'s region', async () => {
    setStagingTables(['orders']);
    mocks.enqueueStagingDataCopy.mockResolvedValue({ ok: true, copyJobId: 'ac_1' });
    await executeStagingReset(withRegion(), job);
    expect(mocks.enqueueCopyWaitTask).toHaveBeenCalledWith({
      appId: 'app_staging', region: 'us-east-1', jobId: 'job_r1', delayMs: 10_000,
    });
  });

  it('re-isolates before enqueuing, closing the window while the copy runs', async () => {
    setStagingTables(['orders']);
    mocks.enqueueStagingDataCopy.mockResolvedValue({ ok: true, copyJobId: 'ac_1' });
    await executeStagingReset(withRegion(), job);
    expect(mocks.isolateStagingApp).toHaveBeenCalledWith(expect.anything(), 'app_staging');
    expect(mocks.isolateStagingMeetingsWebhook).toHaveBeenCalledWith(
      expect.anything(), 'app_staging',
    );
  });

  it('still re-seeds from _seed tables, so a later copy failure does not leave '
    + 'staging empty after the TRUNCATE', async () => {
    setStagingTables(['orders']);
    mocks.enqueueStagingDataCopy.mockResolvedValue({ ok: true, copyJobId: 'ac_1' });
    await executeStagingReset(withRegion(), job);
    expect(mocks.replaySeedData).toHaveBeenCalledWith(prodPool, stagingPool, expect.anything());
  });

  it('completes with a warning, not a failure, on a deployment with no copy engine',
    async () => {
      setStagingTables(['orders']);
      mocks.enqueueStagingDataCopy.mockResolvedValue({
        ok: false, reason: 'unsupported', message: 'Production data was NOT copied into staging.',
      });
      await executeStagingReset(withRegion(), job);
      expect(mocks.appendCloneJobWarnings).toHaveBeenCalledWith(
        expect.anything(), 'job_r1',
        ['Production data was NOT copied into staging.'],
      );
      expect(mocks.setCloneJobStatus).toHaveBeenCalledWith(
        expect.anything(), 'job_r1', expect.objectContaining({ status: 'completed' }),
      );
      expect(mocks.touchEnvironmentTimestamp).toHaveBeenCalled();
    });

  it('throws — leaving the queue to retry — when the enqueue lost a race', async () => {
    setStagingTables(['orders']);
    mocks.enqueueStagingDataCopy.mockResolvedValue({
      ok: false, reason: 'already_active', message: 'conflicted with a concurrent one',
    });
    await expect(executeStagingReset(withRegion(), job)).rejects.toThrow(/concurrent/);
  });
});

/**
 * REGRESSION for defect 2 (final whole-branch review).
 *
 * executeStagingReset called `await replaySeedData(prodPool, stagingPool,
 * logger);` and dropped the return value on the floor. replaySeedData does not
 * throw on a bad table — it soft-fails per table, pushes a string onto
 * `warnings`, and carries on. executeClone has always appended those to the
 * job; reset did not, so a reset that failed to repopulate a table finished
 * with status 'completed' and no warning anywhere the user could see.
 *
 * This is compounded by the two lists coming from different databases: the
 * TRUNCATE set is introspected from STAGING while everything that refills it
 * (replaySeedData and the app-copy plan) is introspected from PRODUCTION. A
 * table that exists only on staging is emptied and then never repopulated,
 * and nothing downstream emits a warning for it because from production's
 * side it was never in scope at all.
 */
describe('executeStagingReset — seed warnings reach the job record', () => {
  it('appends replaySeedData warnings to the job instead of discarding them', async () => {
    mocks.replaySeedData.mockResolvedValue({
      tables: ['widgets', 'orders'],
      rows: 3,
      warnings: [
        'Seed insert into orders failed at offset 0: null value in column "sku"',
      ],
    });

    await executeStagingReset(deps as never, job);

    expect(mocks.appendCloneJobWarnings).toHaveBeenCalledWith(
      deps.controlDb,
      'job_r1',
      ['Seed insert into orders failed at offset 0: null value in column "sku"'],
    );
  });

  it('does not append an empty warning list when the re-seed was clean', async () => {
    await executeStagingReset(deps as never, job);
    // Only warning-free calls remain: nothing should have been appended at all
    // for a reset where both lists agree and replaySeedData reported nothing.
    expect(mocks.appendCloneJobWarnings).not.toHaveBeenCalled();
  });

  it('still reports the job completed — warnings inform, they do not fail the reset', async () => {
    mocks.replaySeedData.mockResolvedValue({
      tables: ['widgets', 'orders'], rows: 0, warnings: ['Seed table orders flagged but has no columns; skipping'],
    });
    await executeStagingReset(deps as never, job);
    expect(mocks.setCloneJobStatus).toHaveBeenCalledWith(
      deps.controlDb, 'job_r1', expect.objectContaining({ status: 'completed' }),
    );
  });

  it('names every schema object the reconcile destroyed, on the job', async () => {
    // THE STANDING RULE. Reset is entitled to drop staging-only objects and
    // rewrite diverged types so that it always succeeds; the other half of
    // that deal is that a user who loses a scratch table learns it from the
    // job record rather than by noticing later.
    setReconcile([
      'dropped staging-only table "scratch_notes" (it does not exist in production)',
      'rewrote column "notes"."body" from integer to text',
    ]);

    await executeStagingReset(deps as never, job);

    const appended = mocks.appendCloneJobWarnings.mock.calls.flatMap((c) => c[2] as string[]);
    const disclosure = appended.find((w) => w.includes('scratch_notes'));
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain('rewrote column "notes"."body" from integer to text');
    // And it says which side was changed — the whole reassurance a user needs.
    expect(disclosure).toContain('production was not touched');
  });

  it('does not claim to have destroyed anything when nothing diverged', async () => {
    setReconcile([]);
    await executeStagingReset(deps as never, job);
    const appended = mocks.appendCloneJobWarnings.mock.calls.flatMap((c) => c[2] as string[]);
    expect(appended.some((w) => /destroyed/.test(w))).toBe(false);
  });
});

/**
 * DEFECT 2 — a reset used to fail permanently once staging's schema diverged.
 *
 * Reached through the feature's own supported flow: drop a column in staging,
 * promote (production correctly KEEPS it — promote never applies destructive
 * DDL), then reset. The app-copy engine selects production's columns and
 * INSERTs them into staging verbatim, so every row failed with `column
 * "priority" of relation "notes" does not exist` and the job went to `failed`
 * — permanently, because nothing in the pipeline ever reconciled schema.
 *
 * The fix is a production -> staging schema replay, now DESTRUCTIVE against
 * staging so that a reset always succeeds. These tests assert the wiring, the
 * ordering and the disclosure; the reconcile's own direction, destruction and
 * guard behaviour are covered in staging-schema-reconcile.test.ts.
 */
describe('executeStagingReset — schema reconcile', () => {
  it('reconciles schema AFTER the truncate, on an empty table', async () => {
    // THE ORDER IS LOAD-BEARING, not incidental. `ALTER COLUMN ... TYPE` on a
    // POPULATED table needs a `USING` clause and fails outright when no
    // implicit cast exists — the live smoke test's `body text -> integer` is
    // exactly that case. On an empty table it always succeeds. Reconciling
    // first would mean choosing how to cast rows the very next statement
    // deletes; reconciling second means never having to. Reverse these two and
    // "a reset always succeeds" stops being true.
    const order: string[] = [];
    mocks.reconcileStagingSchema.mockImplementation(async () => {
      order.push('reconcile');
      return { applied: [], destroyed: [] };
    });
    stagingPool.query.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && /^TRUNCATE TABLE/i.test(sql)) order.push('truncate');
      return defaultStagingQueryResponse(sql);
    });

    await executeStagingReset(deps as never, job);

    expect(order).toEqual(['truncate', 'reconcile']);
  });

  it('passes production as the schema SOURCE and staging as the target', async () => {
    await executeStagingReset(deps as never, job);
    // Reversed, this would replay staging's schema onto PRODUCTION — and the
    // reconcile now EXECUTES destructive DDL, so that mistake drops a
    // customer's production columns.
    expect(mocks.reconcileStagingSchema).toHaveBeenCalledWith(
      expect.objectContaining({
        prodPool: deps.prodPool,
        stagingPool: deps.stagingPool,
        stagingAppId: 'app_staging',
      }),
    );
    const [{ prodPool: p, stagingPool: s }] = mocks.reconcileStagingSchema.mock.calls[0];
    expect(p).not.toBe(stagingPool);
    expect(s).not.toBe(prodPool);
  });

  it('hands the reconcile a REAL guard, not a stub — it refuses a wrong database', async () => {
    // The reconcile issues DROP TABLE / DROP COLUMN / ALTER COLUMN ... TYPE
    // against staging, so it must be able to re-run the same three guards the
    // TRUNCATE uses, immediately before its own DDL. Asserting the callback is
    // merely PRESENT would pass against a no-op; this captures it and invokes
    // it for real, with the staging pool answering `current_database()` with
    // somebody else's database.
    let guard: (() => Promise<void>) | null = null;
    mocks.reconcileStagingSchema.mockImplementation(async (args: never) => {
      guard = (args as unknown as { assertStagingTarget: () => Promise<void> })
        .assertStagingTarget;
      return { applied: [], destroyed: [] };
    });

    await executeStagingReset(deps as never, job);
    expect(guard).toBeInstanceOf(Function);

    // Passes while the connection is pointed at the staging database...
    await expect(guard!()).resolves.toBeUndefined();

    // ...and refuses the moment it is not. This is Guard 3, the only one that
    // catches a swap of the two getAppPoolForApp assignments upstream.
    stagingPool.query.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && /current_database/.test(sql)) {
        return { rows: [{ current_database: 'db_someone_elses_app' }] };
      }
      return { rows: [] };
    });
    await expect(guard!()).rejects.toThrow(/refusing to alter schema.*db_someone_elses_app/s);
  });

  it('never re-seeds, and fails the job, when the schema replay itself fails', async () => {
    // The truncate has already run by this point — that is the deliberate
    // ordering — so staging is left EMPTY. That is the right outcome for a
    // half-reconciled schema: seeding production's rows into a schema that is
    // still wrong is how the original defect produced 3 failed rows and a
    // useless staging app. Fail loudly and leave it recoverable by re-running
    // the reset, which is now idempotent.
    mocks.reconcileStagingSchema.mockRejectedValue(new Error('DROP COLUMN boom'));
    await expect(executeStagingReset(deps as never, job)).rejects.toThrow('DROP COLUMN boom');
    expect(mocks.replaySeedData).not.toHaveBeenCalled();
    expect(mocks.enqueueStagingDataCopy).not.toHaveBeenCalled();
    expect(mocks.setCloneJobStatus).toHaveBeenLastCalledWith(
      deps.controlDb, 'job_r1', expect.objectContaining({ status: 'failed' }),
    );
  });

});
