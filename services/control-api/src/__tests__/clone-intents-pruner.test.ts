import { describe, it, expect, vi } from 'vitest';

describe('clone-intents-pruner', () => {
  it('deletes expired unredeemed intents and old audit rows', async () => {
    const { runOnce } = await import('../services/clone-intents-pruner.js');
    const queries: string[] = [];
    const controlDb = {
      query: vi.fn(async (sql: string) => { queries.push(sql); return { rowCount: 2 }; }),
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const out = await runOnce(controlDb as any, logger);

    expect(out).toEqual({ expired: 2, audit: 2 });
    expect(queries[0]).toMatch(/redeemed_at IS NULL/);
    expect(queries[0]).toMatch(/expires_at\s*<\s*now\(\)/);
    expect(queries[1]).toMatch(/redeemed_at IS NOT NULL/);
  });

  it('does not delete unexpired unredeemed intents', async () => {
    const { runOnce } = await import('../services/clone-intents-pruner.js');
    const controlDb = { query: vi.fn(async () => ({ rowCount: 0 })) };
    const logger = { info: vi.fn(), error: vi.fn() };
    const out = await runOnce(controlDb as any, logger);
    expect(out).toEqual({ expired: 0, audit: 0 });
    expect(logger.info).not.toHaveBeenCalled();
  });
});

// The two tests above only regex the SQL text — they would pass against an
// inverted predicate or a loop that never loops. These pin the behaviour that
// actually bounds the plaintext-recoverable window.
describe('clone-intents-pruner expired drain loop', () => {
  it('keeps deleting while a full batch comes back, and stops on a short one', async () => {
    const { runExpiredPass } = await import('../services/clone-intents-pruner.js');
    // 500 is BATCH_LIMIT: two full batches then a partial one.
    const counts = [500, 500, 137];
    let i = 0;
    const controlDb = { query: vi.fn(async () => ({ rowCount: counts[i++] })) };

    const out = await runExpiredPass(controlDb as any);

    expect(controlDb.query).toHaveBeenCalledTimes(3);
    expect(out).toEqual({ expired: 1137, batches: 3, hitLimit: false });
  });

  it('stops after a single pass when the first batch is already short', async () => {
    const { runExpiredPass } = await import('../services/clone-intents-pruner.js');
    const controlDb = { query: vi.fn(async () => ({ rowCount: 3 })) };

    const out = await runExpiredPass(controlDb as any);

    expect(controlDb.query).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ expired: 3, batches: 1, hitLimit: false });
  });

  it('performs exactly one pass when nothing is expired', async () => {
    const { runExpiredPass } = await import('../services/clone-intents-pruner.js');
    const controlDb = { query: vi.fn(async () => ({ rowCount: 0 })) };

    const out = await runExpiredPass(controlDb as any);

    expect(controlDb.query).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ expired: 0, batches: 1, hitLimit: false });
  });

  it('honours the per-tick iteration bound instead of spinning forever', async () => {
    const { runExpiredPass } = await import('../services/clone-intents-pruner.js');
    // Always a full batch — a pathological table. The loop must still return.
    const controlDb = { query: vi.fn(async () => ({ rowCount: 500 })) };

    const out = await runExpiredPass(controlDb as any);

    expect(out.hitLimit).toBe(true);
    expect(out.batches).toBe(40);
    expect(out.expired).toBe(40 * 500);
    expect(controlDb.query).toHaveBeenCalledTimes(40);
  });

  it('deletes only expired UNREDEEMED rows', async () => {
    const { runExpiredPass } = await import('../services/clone-intents-pruner.js');
    const queries: string[] = [];
    const controlDb = {
      query: vi.fn(async (sql: string) => { queries.push(sql); return { rowCount: 0 }; }),
    };
    await runExpiredPass(controlDb as any);
    expect(queries[0]).toMatch(/redeemed_at IS NULL/);
    expect(queries[0]).not.toMatch(/redeemed_at IS NOT NULL/);
    expect(queries[0]).toMatch(/expires_at\s*<\s*now\(\)/);
  });
});

describe('clone-intents-pruner audit pass', () => {
  it('runs exactly one batch and does not loop, even on a full batch', async () => {
    const { runAuditPass } = await import('../services/clone-intents-pruner.js');
    const controlDb = { query: vi.fn(async () => ({ rowCount: 500 })) };

    const out = await runAuditPass(controlDb as any);

    expect(controlDb.query).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ audit: 500 });
  });

  it('targets redeemed rows older than 30 days', async () => {
    const { runAuditPass } = await import('../services/clone-intents-pruner.js');
    const queries: string[] = [];
    const controlDb = {
      query: vi.fn(async (sql: string) => { queries.push(sql); return { rowCount: 0 }; }),
    };
    await runAuditPass(controlDb as any);
    expect(queries[0]).toMatch(/redeemed_at IS NOT NULL/);
    expect(queries[0]).toMatch(/interval '30 days'/);
  });
});

describe('clone-intents-pruner scheduling', () => {
  it('runs the two passes on separate intervals, expired far more often', async () => {
    vi.useFakeTimers();
    try {
      const { startCloneIntentsPruner } = await import('../services/clone-intents-pruner.js');
      const seen: string[] = [];
      const controlDb = {
        query: vi.fn(async (sql: string) => {
          seen.push(/redeemed_at IS NOT NULL/.test(sql) ? 'audit' : 'expired');
          return { rowCount: 0 };
        }),
      };
      const logger = { info: vi.fn(), error: vi.fn() };

      const handle = startCloneIntentsPruner(controlDb as any, logger, {
        expiredIntervalMs: 1000,
        auditIntervalMs: 100000,
      });
      // Let the two immediate ticks settle.
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.filter((s) => s === 'expired')).toHaveLength(1);
      expect(seen.filter((s) => s === 'audit')).toHaveLength(1);

      // Five expired intervals later: five more expired passes, no more audit.
      await vi.advanceTimersByTimeAsync(5000);
      expect(seen.filter((s) => s === 'expired')).toHaveLength(6);
      expect(seen.filter((s) => s === 'audit')).toHaveLength(1);

      await handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs an error when the expired pass hits its batch bound', async () => {
    vi.useFakeTimers();
    try {
      const { startCloneIntentsPruner } = await import('../services/clone-intents-pruner.js');
      const controlDb = {
        query: vi.fn(async (sql: string) =>
          (/redeemed_at IS NOT NULL/.test(sql) ? { rowCount: 0 } : { rowCount: 500 })),
      };
      const logger = { info: vi.fn(), error: vi.fn() };

      const handle = startCloneIntentsPruner(controlDb as any, logger, {
        expiredIntervalMs: 1_000_000,
        auditIntervalMs: 1_000_000,
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ batches: 40, expired: 20000 }),
        expect.stringContaining('batch bound'),
      );

      await handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
