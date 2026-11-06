import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { pruneAuditEvents } from './audit-retention.js';

describe('audit retention admission', () => {
  it('uses the database-derived 180-day cutoff and a bounded default batch', async () => {
    const cutoff = new Date('2000-01-01');
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ cutoff }] }).mockResolvedValueOnce({ rowCount: 0 });
    expect(await pruneAuditEvents({ query } as unknown as pg.Pool)).toEqual({ deletedRows: 0, batches: 1, limited: false });
    expect(query.mock.calls[0][0]).toContain("interval '180 days'");
    expect(query.mock.calls[1][1]).toEqual([cutoff, 1000]);
    expect(query.mock.calls[1][0]).toContain('SKIP LOCKED');
  });
  it('does not admit deletion after the cutoff lookup consumes the default budget', async () => {
    const ticks = [0, 30_001], query = vi.fn().mockResolvedValue({ rows: [{ cutoff: new Date('2000-01-01') }] });
    expect(await pruneAuditEvents({ query } as unknown as pg.Pool, { now: () => ticks.shift() ?? 30_001 }))
      .toEqual({ deletedRows: 0, batches: 0, limited: true });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('propagates a failed batch and does not report or retry nonexistent deletions', async () => {
    const query = vi.fn().mockRejectedValue(new Error('synthetic SQL failure'));
    await expect(pruneAuditEvents({ query } as unknown as pg.Pool, { cutoff: new Date('2000-01-01') }))
      .rejects.toThrow('synthetic SQL failure');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
