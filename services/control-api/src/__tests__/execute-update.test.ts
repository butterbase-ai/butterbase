import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock harness for executeUpdate.
//
// executeUpdate touches S3, two runtime pools, a per-app pool and the control
// DB, so the seams below are replaced with stubs that record the ORDER of every
// externally visible effect. Order is the point: the pre-update snapshot marker
// has to be written before the first write the fork can observe, and nothing may
// be published before the eligibility gate has run.
//
// clone-replay is only partially mocked — replayFunctions keeps its real
// implementation so the env-var tests further down still exercise the actual
// code path.
// ---------------------------------------------------------------------------

interface EffectCall { tag: string; sql?: string; params?: readonly unknown[] }

const H = vi.hoisted(() => ({
  calls: [] as { tag: string; sql?: string; params?: readonly unknown[] }[],
  forkHead: null as string | null,
  drift: null as unknown,
  divergence: null as unknown,
  divergenceThrows: false,
  lineageThrows: false,
  manifestFiles: [] as { path: string; sha256: string; size: number }[],
}));

vi.mock('../services/runtime-db.js', async (orig) => ({
  ...(await orig<typeof import('../services/runtime-db.js')>()),
  getRuntimeDbPool: () => ({
    query: async (sql: string, params?: unknown[]) => {
      H.calls.push({ tag: 'runtime', sql, params });
      if (sql.includes('repo_latest_snapshot FROM apps')) {
        return { rows: [{ db_name: 'db_fork', owner_id: 'user_owner', repo_latest_snapshot: H.forkHead }] };
      }
      if (sql.includes('SELECT db_name FROM apps')) return { rows: [{ db_name: 'db_source' }] };
      if (sql.includes('UPDATE apps SET repo_latest_snapshot')) {
        H.calls.push({ tag: 'publish:apps.head', params });
        return { rows: [] };
      }
      return { rows: [] };
    },
  }),
}));

vi.mock('../services/app-pool.js', async (orig) => ({
  ...(await orig<typeof import('../services/app-pool.js')>()),
  getAppPoolForApp: async () => ({ query: async () => ({ rows: [] }) }),
}));

vi.mock('../services/repo-storage.js', async (orig) => ({
  ...(await orig<typeof import('../services/repo-storage.js')>()),
  getManifestJson: async () => JSON.stringify({ files: H.manifestFiles }),
  copyBlobSameRegion: async () => { H.calls.push({ tag: 'copyBlob' }); },
  getBlobBuffer: async (_appId: string, sha: string) => Buffer.from(`blob-${sha}`),
  putBlobBuffer: async () => { H.calls.push({ tag: 'putBlob' }); },
  putManifest: async () => { H.calls.push({ tag: 'publish:manifest' }); },
  setLatest: async () => { H.calls.push({ tag: 'publish:latest' }); },
}));

vi.mock('../services/app-lineage.js', async (orig) => ({
  ...(await orig<typeof import('../services/app-lineage.js')>()),
  computeDrift: async () => H.drift,
  computeDivergence: async () => {
    if (H.divergenceThrows) throw new Error('fork DB unreachable');
    return H.divergence;
  },
}));

vi.mock('../services/app-state-capture.js', async (orig) => ({
  ...(await orig<typeof import('../services/app-state-capture.js')>()),
  captureAppState: async () => ({ hashes: { schema: 'h', rls: 'h', functions: 'h', config: 'h' } }),
}));

vi.mock('../services/clone-replay.js', async (orig) => {
  const actual = await orig<typeof import('../services/clone-replay.js')>();
  return {
    ...actual,
    replaySchema: vi.fn(async () => { H.calls.push({ tag: 'replaySchema' }); }),
    replayRls: vi.fn(async () => {
      H.calls.push({ tag: 'replayRls' });
      return { replayed: 2, warnings: ['RLS policy t.p failed: policy "p" for table "t" already exists'] };
    }),
    replayNonSecretConfig: vi.fn(async () => {
      H.calls.push({ tag: 'replayConfig' });
      return { warnings: [] };
    }),
    // Delegates to the real implementation: the env-var tests below depend on it.
    replayFunctions: vi.fn(actual.replayFunctions),
  };
});

import { shouldAbortUpdate } from '../services/neon-task-worker.js';
import type { Divergence, DriftResult } from '../services/app-lineage.js';

const drift = (over: Partial<DriftResult> = {}): DriftResult => ({
  is_fork: true, severed: false, source_app_id: 'app_src', behind_by: 1, releases: [], ...over,
});
const div = (over: Partial<Divergence> = {}): Divergence => ({
  repo: false, frontend: false, schema: false, rls: false,
  functions: false, config: false, has_backend_base: true, ...over,
});

describe('shouldAbortUpdate', () => {
  it('proceeds when the fork is still unmodified', () => {
    expect(shouldAbortUpdate(div(), drift())).toEqual({ abort: false, reason: 'ok' });
  });

  it('aborts when the fork was edited after the job was queued', () => {
    expect(shouldAbortUpdate(div({ repo: true }), drift()).abort).toBe(true);
  });

  it('aborts when divergence became unknown', () => {
    expect(shouldAbortUpdate(div({ functions: null }), drift()).abort).toBe(true);
  });

  it('aborts when the fork was severed after queueing', () => {
    expect(shouldAbortUpdate(div(), drift({ severed: true })).abort).toBe(true);
  });

  it('aborts when the fork already carries the newest release', () => {
    expect(shouldAbortUpdate(div(), drift({ behind_by: 0 })))
      .toEqual({ abort: true, reason: 'current' });
  });

  it('aborts when divergence could not be computed at all', () => {
    expect(shouldAbortUpdate(null, drift())).toEqual({ abort: true, reason: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// Function env vars must survive an update.
//
// The spec lists env vars and secrets as UNTOUCHED by a template update. Under
// `overwriteExisting: true` the upsert's ON CONFLICT ... DO UPDATE makes the
// returned function id defined for a PRE-EXISTING fork function, which used to
// fall straight into the `UPDATE app_functions SET encrypted_env_vars = $1`
// write. That write replaces the column wholesale — it does not merge — so a
// fork's own API keys would be silently destroyed by an update that only ever
// intended to refresh code. Clone mode never hit this because ON CONFLICT DO
// NOTHING returns no row for a pre-existing function.
//
// These tests drive replayFunctions against stub pools so the insert can report
// either outcome of the `(xmax = 0) AS inserted` flag deterministically, without
// a live Postgres.
// ---------------------------------------------------------------------------

import { replayFunctions, buildFunctionInsertSql } from '../services/clone-replay.js';
import { encrypt } from '../services/crypto.js';

const ENC_KEY = 'a'.repeat(64);
const noopLogger = { info() {}, warn() {} };

beforeAll(() => {
  process.env.AUTH_ENCRYPTION_KEY = ENC_KEY;
});

interface StubCall { sql: string; params: unknown[] }

/**
 * Source runtime pool: one function named `shared-fn` whose env vars declare
 * BUTTERBASE_APP_ID — a static fill, so `merged` is non-empty and the env-var
 * write path is genuinely reached (no mint credentials needed).
 */
function makeSourcePool() {
  const calls: StubCall[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM function_triggers')) return { rows: [] };
    if (sql.includes('encrypted_env_vars IS NOT NULL')) {
      return {
        rows: [{
          name: 'shared-fn',
          encrypted_env_vars: encrypt(JSON.stringify({ BUTTERBASE_APP_ID: 'app_src' }), ENC_KEY),
        }],
      };
    }
    // The source function listing.
    return {
      rows: [{
        id: 'fn_src_1', name: 'shared-fn', code: '/* new template code */',
        description: null, timeout_ms: 30000, memory_limit_mb: 128,
        agent_tool: false, agent_tool_description: null,
        agent_tool_mode: null, agent_tool_exposed_to: null,
      }],
    };
  });
  return { pool: { query } as never, calls, query };
}

/**
 * Dest runtime pool whose function upsert reports the given insert/update
 * outcome. `existingEnv` is what the fork's own row already holds — null models
 * a row a PRIOR attempt inserted but never got to fill.
 */
function makeDestPool(inserted: boolean, existingEnv: Record<string, string> | null = null) {
  const calls: StubCall[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('INSERT INTO app_functions')) {
      return { rows: [{ id: 'fn_dest_1', inserted }] };
    }
    if (sql.includes('SELECT encrypted_env_vars FROM app_functions')) {
      return {
        rows: [{
          encrypted_env_vars: existingEnv ? encrypt(JSON.stringify(existingEnv), ENC_KEY) : null,
        }],
      };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, calls, query };
}

const envWrites = (calls: StubCall[]) =>
  calls.filter((c) => /UPDATE app_functions SET encrypted_env_vars/.test(c.sql));

describe('function env vars under overwriteExisting (template update)', () => {
  it('reports whether the upsert inserted or updated the row', () => {
    expect(buildFunctionInsertSql(true)).toMatch(/RETURNING id, \(xmax = 0\) AS inserted/);
    expect(buildFunctionInsertSql(false)).toMatch(/RETURNING id, \(xmax = 0\) AS inserted/);
  });

  it("does not overwrite a pre-existing fork function's env vars", async () => {
    const src = makeSourcePool();
    // Row already existed on the fork, carrying the fork owner's own value.
    const dest = makeDestPool(false, { BUTTERBASE_APP_ID: 'app_fork' });
    const result = await replayFunctions(
      src.pool, dest.pool, 'app_src', 'app_fork', 'user_1', noopLogger,
      { overwriteExisting: true },
    );

    expect(envWrites(dest.calls)).toHaveLength(0);
    expect(result.count).toBe(1);
    // The fork's own env vars are intact, so nothing is "unfilled" for it and
    // the dashboard raises no banner.
    expect(result.unfilledEnvVars['shared-fn']).toBeUndefined();
  });

  it('reports unfilled keys for a row a prior attempt inserted but never filled', async () => {
    // `xmax = 0` is per-statement, not per-job: attempt 1 INSERTs the function
    // and dies before writing its env vars, attempt 2 sees inserted=false. The
    // env-var write stays skipped (we cannot tell it from a fork's own row), but
    // the bookkeeping must still surface the gap instead of shipping a function
    // with no configuration and no banner.
    const src = makeSourcePool();
    const dest = makeDestPool(false, null); // row exists, env vars empty
    const result = await replayFunctions(
      src.pool, dest.pool, 'app_src', 'app_fork', 'user_1', noopLogger,
      { overwriteExisting: true },
    );

    expect(envWrites(dest.calls)).toHaveLength(0);
    expect(result.unfilledEnvVars['shared-fn']).toEqual(['BUTTERBASE_APP_ID']);
  });

  it('refuses to guess when the upsert stops reporting the inserted flag', async () => {
    const src = makeSourcePool();
    const dest = {
      pool: {
        query: vi.fn(async (sql: string) =>
          sql.includes('INSERT INTO app_functions')
            ? { rows: [{ id: 'fn_dest_1' }] }   // flag missing
            : { rows: [] },
        ),
      } as never,
    };
    const result = await replayFunctions(
      src.pool, dest.pool, 'app_src', 'app_fork', 'user_1', noopLogger,
      { overwriteExisting: true },
    );
    // Per-function soft-fail: recorded as a warning, and no env vars are written.
    expect(result.warnings.join(' ')).toMatch(/inserted.*flag/);
  });

  it('still fills env vars for a function the template newly adds', async () => {
    const src = makeSourcePool();
    const dest = makeDestPool(true); // brand new function on the fork
    await replayFunctions(
      src.pool, dest.pool, 'app_src', 'app_fork', 'user_1', noopLogger,
      { overwriteExisting: true },
    );

    expect(envWrites(dest.calls)).toHaveLength(1);
  });

  it('still replays code and triggers for the pre-existing function', async () => {
    const src = makeSourcePool();
    const dest = makeDestPool(false);
    await replayFunctions(
      src.pool, dest.pool, 'app_src', 'app_fork', 'user_1', noopLogger,
      { overwriteExisting: true },
    );

    const upsert = dest.calls.find((c) => c.sql.includes('INSERT INTO app_functions'));
    expect(upsert!.sql).toMatch(/ON CONFLICT \(app_id, name\) DO UPDATE/);
    expect(upsert!.params).toContain('/* new template code */');
    // Trigger replay is keyed off the same returned id and must still happen.
    expect(src.calls.some((c) => c.sql.includes('FROM function_triggers'))).toBe(true);
  });

  it('clone mode is unaffected: a fresh insert still gets its env vars', async () => {
    const src = makeSourcePool();
    const dest = makeDestPool(true);
    await replayFunctions(
      src.pool, dest.pool, 'app_src', 'app_clone', 'user_1', noopLogger,
      {}, // overwriteExisting defaults to false
    );

    expect(envWrites(dest.calls)).toHaveLength(1);
    const upsert = dest.calls.find((c) => c.sql.includes('INSERT INTO app_functions'));
    expect(upsert!.sql).toMatch(/ON CONFLICT \(app_id, name\) DO NOTHING/);
  });
});

// ---------------------------------------------------------------------------
// executeUpdate — the orchestration itself.
// ---------------------------------------------------------------------------

import {
  executeUpdate,
  resolveCloneDispatch,
  classifyUpdateResume,
} from '../services/neon-task-worker.js';
import { replaySchema, replayRls, replayNonSecretConfig } from '../services/clone-replay.js';
import { filterAdditive } from '../services/schema-additive-filter.js';
import { validateManifest } from '../services/repo-manifest.js';

const SHA_A = 'a'.repeat(64);
const FILES = [{ path: 'src/app.txt', sha256: SHA_A, size: 12 }];
/** The snapshot id executeUpdate will publish, derived exactly as it derives it. */
const TARGET_SNAPSHOT = validateManifest({ files: FILES }).snapshotId;

const baseJob = () => ({
  id: 'cj_update_1',
  mode: 'update',
  status: 'pending',
  source_app_id: 'app_src',
  source_snapshot_id: 'snap_source',
  source_region: 'us-east-1',
  dest_app_id: 'app_fork',
  dest_region: 'us-east-1',
  requested_by_user_id: 'user_1',
  target_release_id: 'rel_7',
  pre_sync_snapshot_id: null as string | null,
});

let job: ReturnType<typeof baseJob>;

/** Control-DB stub. Records every job/lineage write in call order. */
const controlDb = {
  query: async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT * FROM template_clone_jobs')) return { rows: [job] };
    if (sql.includes('pre_sync_snapshot_id = $1')) {
      H.calls.push({ tag: 'preSync', params });
      return { rows: [] };
    }
    if (sql.includes('UPDATE app_lineage')) {
      if (H.lineageThrows) throw new Error('control DB write failed');
      H.calls.push({ tag: 'lineage', params });
      return { rows: [] };
    }
    if (sql.includes('UPDATE template_clone_jobs')) {
      H.calls.push({ tag: 'jobStatus', sql, params });
      return { rows: [] };
    }
    return { rows: [] };
  },
} as never;

const task = (over: Partial<{ attempts: number; max_attempts: number }> = {}) => ({
  id: 1, app_id: 'app_fork', task_type: 'clone' as const, status: 'processing',
  attempts: 1, max_attempts: 3, last_error: null, locked_at: null,
  run_after: new Date(), created_at: new Date(),
  task_meta: { job_id: 'cj_update_1' },
  ...over,
});

const silentLogger = { info() {}, warn() {}, error() {} };

const tags = () => H.calls.map((c) => c.tag);
const statusWrites = () =>
  H.calls.filter((c) => c.tag === 'jobStatus').flatMap((c) => (c.params ?? []) as unknown[]);

beforeEach(() => {
  vi.clearAllMocks();
  H.calls.length = 0;
  H.forkHead = 'snap_pre';
  H.manifestFiles = FILES;
  H.divergenceThrows = false;
  H.lineageThrows = false;
  H.drift = { is_fork: true, severed: false, source_app_id: 'app_src', behind_by: 1, releases: [] };
  H.divergence = {
    repo: false, frontend: false, schema: false, rls: false,
    functions: false, config: false, has_backend_base: true,
  };
  job = baseJob();
  process.env.AUTH_ENCRYPTION_KEY = ENC_KEY;
});

describe('resolveCloneDispatch', () => {
  it('routes an update-mode job to the update path', () => {
    expect(resolveCloneDispatch({ mode: 'update' })).toBe('update');
  });
  it('routes a clone-mode job to the clone path', () => {
    expect(resolveCloneDispatch({ mode: 'clone' })).toBe('clone');
  });
  it('routes a missing job to the clone path so it raises its own error', () => {
    expect(resolveCloneDispatch(null)).toBe('clone');
  });
});

describe('classifyUpdateResume', () => {
  const args = (o: Partial<Parameters<typeof classifyUpdateResume>[0]>) => ({
    preSyncSnapshotId: null, currentHead: 'snap_pre', targetSnapshotId: 'snap_target', ...o,
  });

  it('is fresh before any attempt has passed the gate', () => {
    expect(classifyUpdateResume(args({}))).toBe('fresh');
  });

  it('is fresh when a prior attempt never published, so the full gate re-runs', () => {
    expect(classifyUpdateResume(args({ preSyncSnapshotId: 'snap_pre', currentHead: 'snap_pre' })))
      .toBe('fresh');
  });

  it('is a republish when HEAD is the snapshot this job itself publishes', () => {
    expect(classifyUpdateResume(args({ preSyncSnapshotId: 'snap_pre', currentHead: 'snap_target' })))
      .toBe('republish');
  });

  it('is ambiguous when HEAD matches neither — someone else moved the repo', () => {
    expect(classifyUpdateResume(args({ preSyncSnapshotId: 'snap_pre', currentHead: 'snap_user_edit' })))
      .toBe('ambiguous');
  });

  it('never reads a bare HEAD match as our own write without a pre-sync marker', () => {
    expect(classifyUpdateResume(args({ preSyncSnapshotId: null, currentHead: 'snap_target' })))
      .toBe('fresh');
  });
});

describe('executeUpdate', () => {
  it('returns without touching the fork when the job is already terminal', async () => {
    job.status = 'completed';
    await executeUpdate(controlDb, task(), silentLogger);
    expect(H.calls).toHaveLength(0);
  });

  it('records the pre-update snapshot BEFORE publishing anything', async () => {
    await executeUpdate(controlDb, task(), silentLogger);
    const order = tags();
    expect(order.indexOf('preSync')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('preSync')).toBeLessThan(order.indexOf('publish:manifest'));
    expect(order.indexOf('preSync')).toBeLessThan(order.indexOf('publish:latest'));
    expect(order.indexOf('preSync')).toBeLessThan(order.indexOf('publish:apps.head'));
    // and it records where the fork actually was, not where it is going
    const preSync = H.calls.find((c) => c.tag === 'preSync')!;
    expect(preSync.params![0]).toBe('snap_pre');
  });

  it('runs the whole pipeline and completes', async () => {
    await executeUpdate(controlDb, task(), silentLogger);

    expect(tags()).toContain('replaySchema');
    expect(tags()).toContain('replayRls');
    expect(tags()).toContain('replayConfig');
    expect(statusWrites()).toContain('completed');

    // schema goes through the additive-only filter
    expect(vi.mocked(replaySchema).mock.calls[0][4]).toEqual({ filter: filterAdditive });
    // RLS runs (a release's new table would otherwise land with no policies)
    expect(vi.mocked(replayRls)).toHaveBeenCalledTimes(1);
    // config replay may not overwrite what the fork already has
    expect(vi.mocked(replayNonSecretConfig).mock.calls[0][5]).toEqual({ insertOnly: true });
  });

  it('advances the lineage base to the target release and the new snapshot', async () => {
    await executeUpdate(controlDb, task(), silentLogger);
    const lineage = H.calls.find((c) => c.tag === 'lineage')!;
    expect(lineage.params![0]).toBe('rel_7');
    expect(lineage.params![1]).toBe(TARGET_SNAPSHOT);
  });

  it('throws when the lineage advance fails, so the queue retries it', async () => {
    H.lineageThrows = true;
    await expect(executeUpdate(controlDb, task(), silentLogger)).rejects.toThrow(/control DB write failed/);
    // not marked completed — the fork would otherwise read as user-modified forever
    expect(statusWrites()).not.toContain('completed');
  });

  it('refuses to advance lineage to an unnamed base', async () => {
    job.target_release_id = null as never;
    await expect(executeUpdate(controlDb, task(), silentLogger)).rejects.toThrow(/target_release_id/);
  });

  it('aborts without publishing when the fork was edited after queueing', async () => {
    H.divergence = { ...(H.divergence as object), repo: true };
    await executeUpdate(controlDb, task(), silentLogger);

    expect(tags()).not.toContain('publish:manifest');
    expect(tags()).not.toContain('preSync');
    expect(statusWrites()).toContain('failed');
    expect(statusWrites().some((p) => typeof p === 'string' && /modified/.test(p))).toBe(true);
  });

  it('aborts when the fork DB could not be read', async () => {
    H.divergenceThrows = true;
    await executeUpdate(controlDb, task(), silentLogger);
    expect(tags()).not.toContain('publish:manifest');
    expect(statusWrites().some((p) => typeof p === 'string' && /unknown/.test(p))).toBe(true);
  });

  it('aborts a retry whose fork HEAD moved to something neither we nor the job wrote', async () => {
    // The two-weeks-later Retry: a marker exists, but the owner has since pushed.
    job.pre_sync_snapshot_id = 'snap_pre';
    H.forkHead = 'snap_owner_pushed_this';
    await executeUpdate(controlDb, task(), silentLogger);

    expect(tags()).not.toContain('publish:manifest');
    expect(statusWrites()).toContain('failed');
    expect(statusWrites().some((p) => typeof p === 'string' && /matches neither/.test(p))).toBe(true);
  });

  it('re-runs the full gate on a retry that never published, even with a marker', async () => {
    job.pre_sync_snapshot_id = 'snap_pre';
    H.forkHead = 'snap_pre';
    H.divergence = { ...(H.divergence as object), functions: true };

    await executeUpdate(controlDb, task(), silentLogger);

    // Functions edited in the meantime — the marker must not buy a free pass.
    expect(tags()).not.toContain('publish:manifest');
    expect(statusWrites()).toContain('failed');
  });

  it('finishes a partially applied update instead of stranding the fork', async () => {
    // A prior attempt published the repo and then died. Every divergence signal
    // is now our own half-finished work.
    job.pre_sync_snapshot_id = 'snap_pre';
    H.forkHead = TARGET_SNAPSHOT;
    H.divergence = { ...(H.divergence as object), repo: true, functions: true };
    H.drift = { is_fork: true, severed: false, source_app_id: 'app_src', behind_by: 0, releases: [] };

    await executeUpdate(controlDb, task(), silentLogger);

    expect(statusWrites()).toContain('completed');
    // the marker is not overwritten with the half-updated HEAD
    expect(tags()).not.toContain('preSync');
  });

  it('still refuses to finish a resumed update on a severed fork', async () => {
    job.pre_sync_snapshot_id = 'snap_pre';
    H.forkHead = TARGET_SNAPSHOT;
    H.drift = { is_fork: true, severed: true, source_app_id: 'app_src', behind_by: 0, releases: [] };

    await executeUpdate(controlDb, task(), silentLogger);
    expect(statusWrites()).toContain('failed');
    expect(statusWrites()).not.toContain('completed');
  });
});
