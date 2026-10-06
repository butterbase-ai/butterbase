import { describe, it, expect, beforeEach } from 'vitest';
import type pg from 'pg';
import {
  isAppCopyEngineAvailable,
  __resetAppCopyEngineCache,
  enqueueStagingDataCopy,
  classifyStagingCopyWait,
  stagingCopyWarnings,
  STAGING_COPY_OPTIONS,
  COPY_UNSUPPORTED_WARNING,
  newCopyJobId,
  type CopyJobSnapshot,
} from './staging-data-copy.js';

interface Call { sql: string; params: unknown[] }

function fakePool(handler: (sql: string, params: unknown[]) => unknown): {
  pool: pg.Pool; calls: Call[];
} {
  const calls: Call[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const out = handler(sql, params);
      if (out instanceof Error) throw out;
      return (out ?? { rows: [], rowCount: 0 }) as never;
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

beforeEach(() => {
  __resetAppCopyEngineCache();
});

describe('isAppCopyEngineAvailable', () => {
  it('is true when to_regclass resolves app_copy_jobs', async () => {
    const { pool } = fakePool(() => ({ rows: [{ reg: 'app_copy_jobs' }] }));
    expect(await isAppCopyEngineAvailable(pool)).toBe(true);
  });

  it('is false on an OSS deployment, where the table does not exist', async () => {
    const { pool } = fakePool(() => ({ rows: [{ reg: null }] }));
    expect(await isAppCopyEngineAvailable(pool)).toBe(false);
  });

  it('caches the answer so executeClone does not pay a round trip per job', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [{ reg: 'app_copy_jobs' }] }));
    await isAppCopyEngineAvailable(pool);
    await isAppCopyEngineAvailable(pool);
    await isAppCopyEngineAvailable(pool);
    expect(calls).toHaveLength(1);
  });

  it('does not cache a THROWN probe, so a control-DB blip cannot pin the process '
    + 'to seed-only staging forever', async () => {
    let fail = true;
    const { pool } = fakePool(() => (fail ? new Error('connection reset') : { rows: [{ reg: 'app_copy_jobs' }] }));
    await expect(isAppCopyEngineAvailable(pool)).rejects.toThrow('connection reset');
    fail = false;
    expect(await isAppCopyEngineAvailable(pool)).toBe(true);
  });
});

describe('enqueueStagingDataCopy', () => {
  it('degrades rather than throwing when the deployment has no engine', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [{ reg: null }] }));
    const res = await enqueueStagingDataCopy({
      controlDb: pool, prodAppId: 'app_prod', stagingAppId: 'app_stg',
      region: 'us-east-1', requestedByUserId: 'usr_1',
    });
    expect(res).toEqual({ ok: false, reason: 'unsupported', message: COPY_UNSUPPORTED_WARNING });
    // Probe only — nothing was inserted into a table that does not exist.
    expect(calls.filter((c) => /INSERT INTO app_copy_jobs/.test(c.sql))).toHaveLength(0);
  });

  it('writes one copy row with autoPlan, both regions equal, and no companions', async () => {
    const { pool, calls } = fakePool((sql) =>
      /to_regclass/.test(sql) ? { rows: [{ reg: 'app_copy_jobs' }] } : { rows: [] });
    const res = await enqueueStagingDataCopy({
      controlDb: pool, prodAppId: 'app_prod', stagingAppId: 'app_stg',
      region: 'us-east-1', requestedByUserId: 'usr_1',
    });
    expect(res.ok).toBe(true);
    const insert = calls.find((c) => /INSERT INTO app_copy_jobs/.test(c.sql))!;
    expect(insert).toBeDefined();
    // $4 fills BOTH source_region and dest_region: staging is always same-region.
    expect(insert.sql).toContain('$4, $4');
    expect(insert.params[1]).toBe('app_prod');
    expect(insert.params[2]).toBe('app_stg');
    expect(insert.params[3]).toBe('us-east-1');
    expect(JSON.parse(insert.params[4] as string)).toEqual({
      autoPlan: true, origin: 'staging', skipUsers: false, skipStorage: false, companions: {},
    });
    expect(insert.sql).toContain("'copy'");
    expect(insert.sql).not.toContain("'move'");
  });

  it('refuses outright when source and destination are the same app', async () => {
    const { pool } = fakePool(() => ({ rows: [{ reg: 'app_copy_jobs' }] }));
    await expect(enqueueStagingDataCopy({
      controlDb: pool, prodAppId: 'app_x', stagingAppId: 'app_x',
      region: 'us-east-1', requestedByUserId: 'usr_1',
    })).rejects.toThrow(/equals destination/);
  });

  it('ADOPTS the in-flight copy when the active-jobs index rejects a resumed enqueue', async () => {
    const conflict = Object.assign(new Error('duplicate key'), {
      code: '23505', constraint: 'idx_app_copy_jobs_active',
    });
    const { pool } = fakePool((sql) => {
      if (/to_regclass/.test(sql)) return { rows: [{ reg: 'app_copy_jobs' }] };
      if (/INSERT INTO app_copy_jobs/.test(sql)) return conflict;
      return { rows: [{ id: 'ac_existing' }] };
    });
    const res = await enqueueStagingDataCopy({
      controlDb: pool, prodAppId: 'app_prod', stagingAppId: 'app_stg',
      region: 'us-east-1', requestedByUserId: 'usr_1',
    });
    expect(res).toEqual({ ok: true, copyJobId: 'ac_existing' });
  });

  it('rethrows a unique violation that is NOT the active-jobs index', async () => {
    const other = Object.assign(new Error('dupe'), {
      code: '23505', constraint: 'app_copy_jobs_pkey',
    });
    const { pool } = fakePool((sql) =>
      /to_regclass/.test(sql) ? { rows: [{ reg: 'app_copy_jobs' }] } : other);
    await expect(enqueueStagingDataCopy({
      controlDb: pool, prodAppId: 'app_prod', stagingAppId: 'app_stg',
      region: 'us-east-1', requestedByUserId: 'usr_1',
    })).rejects.toThrow('dupe');
  });
});

describe('newCopyJobId', () => {
  it('matches the engine\'s own id shape', () => {
    expect(newCopyJobId()).toMatch(/^ac_[A-Za-z0-9_-]{24}$/);
  });
});

describe('classifyStagingCopyWait', () => {
  const base = {
    status: 'processing' as const,
    phase: 'data',
    created_at: new Date('2026-09-09T10:00:00Z'),
    started_at: new Date('2026-09-09T10:00:01Z'),
    error_message: null,
  };

  it('keeps waiting while the copy is running', () => {
    expect(classifyStagingCopyWait({
      copy: base, now: new Date('2026-09-09T10:05:00Z'),
    })).toEqual({ kind: 'waiting' });
  });

  it('keeps waiting on a pending copy inside the claim window', () => {
    expect(classifyStagingCopyWait({
      copy: { ...base, status: 'pending', phase: null, started_at: null },
      now: new Date('2026-09-09T10:01:00Z'),
    })).toEqual({ kind: 'waiting' });
  });

  it('is done when the copy completed', () => {
    expect(classifyStagingCopyWait({
      copy: { ...base, status: 'completed' }, now: new Date('2026-09-09T10:30:00Z'),
    })).toEqual({ kind: 'done' });
  });

  it('fails, naming the phase and the engine error, when the copy failed', () => {
    const v = classifyStagingCopyWait({
      copy: { ...base, status: 'failed', phase: 'verify', error_message: '2 table(s) short' },
      now: new Date('2026-09-09T10:30:00Z'),
    });
    expect(v.kind).toBe('failed');
    expect(v.kind === 'failed' && v.message).toContain('verify');
    expect(v.kind === 'failed' && v.message).toContain('2 table(s) short');
  });

  it('fails on an ABORTED copy rather than completing the staging job anyway', () => {
    const v = classifyStagingCopyWait({
      copy: { ...base, status: 'aborted' }, now: new Date('2026-09-09T10:30:00Z'),
    });
    expect(v.kind).toBe('failed');
    expect(v.kind === 'failed' && v.message).toContain('aborted');
  });

  it('fails when nothing ever claimed the copy — the table exists but no worker runs', () => {
    const v = classifyStagingCopyWait({
      copy: { ...base, status: 'pending', phase: null, started_at: null },
      now: new Date('2026-09-09T10:20:00Z'),
      claimTimeoutMs: 10 * 60 * 1000,
    });
    expect(v.kind).toBe('failed');
    expect(v.kind === 'failed' && v.message).toMatch(/No app-copy worker claimed/);
  });

  it('fails when a claimed copy exceeds the total budget', () => {
    const v = classifyStagingCopyWait({
      copy: base,
      now: new Date('2026-09-09T20:00:00Z'),
      totalTimeoutMs: 6 * 60 * 60 * 1000,
    });
    expect(v.kind).toBe('failed');
    expect(v.kind === 'failed' && v.message).toMatch(/did not finish within/);
  });

  it('fails, rather than hangs, when the copy row has vanished', () => {
    const v = classifyStagingCopyWait({ copy: null, now: new Date() });
    expect(v.kind).toBe('failed');
    expect(v.kind === 'failed' && v.message).toMatch(/no longer exists/);
  });
});

describe('stagingCopyWarnings', () => {
  const snap = (result: CopyJobSnapshot['result']): CopyJobSnapshot => ({
    id: 'ac_1', status: 'completed', phase: 'verify', error_message: null, result,
    created_at: new Date(), started_at: new Date(),
  });

  it('says nothing when there were no connected accounts', () => {
    expect(stagingCopyWarnings(snap({ reconnect: [] }))).toEqual([]);
    expect(stagingCopyWarnings(snap(null))).toEqual([]);
  });

  it('names the toolkits whose records were copied and then cleared by isolation', () => {
    const w = stagingCopyWarnings(snap({
      reconnect: [
        { email: 'a@example.com', toolkit: 'gmail' },
        { email: 'b@example.com', toolkit: 'gmail' },
        { email: 'b@example.com', toolkit: 'slack' },
      ],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('3 connected-account record(s)');
    expect(w[0]).toContain('gmail, slack');
    expect(w[0]).toContain('cleared by staging isolation');
  });
});

describe('STAGING_COPY_OPTIONS', () => {
  it('never opts into billing or analytics history', () => {
    expect(STAGING_COPY_OPTIONS.companions).toEqual({});
  });
  it('copies users and files — the two things staging was missing', () => {
    expect(STAGING_COPY_OPTIONS.skipUsers).toBe(false);
    expect(STAGING_COPY_OPTIONS.skipStorage).toBe(false);
  });
  it('asks the engine to build its own plan', () => {
    expect(STAGING_COPY_OPTIONS.autoPlan).toBe(true);
  });
});

describe('COPY_UNSUPPORTED_WARNING', () => {
  it('states plainly what is missing rather than hinting at it', () => {
    expect(COPY_UNSUPPORTED_WARNING).toContain('NOT copied');
    expect(COPY_UNSUPPORTED_WARNING).toContain('_seed:true');
    expect(COPY_UNSUPPORTED_WARNING).toContain('auth users');
  });
});
