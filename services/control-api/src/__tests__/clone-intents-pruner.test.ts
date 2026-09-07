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
