import { describe, it, expect, beforeAll, vi } from 'vitest';
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

/** Dest runtime pool whose function upsert reports the given insert/update outcome. */
function makeDestPool(inserted: boolean) {
  const calls: StubCall[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('INSERT INTO app_functions')) {
      return { rows: [{ id: 'fn_dest_1', inserted }] };
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
    const dest = makeDestPool(false); // row already existed on the fork → UPDATEd
    const result = await replayFunctions(
      src.pool, dest.pool, 'app_src', 'app_fork', 'user_1', noopLogger,
      { overwriteExisting: true },
    );

    expect(envWrites(dest.calls)).toHaveLength(0);
    expect(result.count).toBe(1);
    // The fork's own env vars are intact, so nothing is "unfilled" for it.
    expect(result.unfilledEnvVars['shared-fn']).toBeUndefined();
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
