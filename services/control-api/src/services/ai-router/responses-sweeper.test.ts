/**
 * Unit tests for the expired ai_responses sweeper.
 *
 * All DB interaction is mocked — no live database needed.
 *
 * Run with:
 *   pnpm vitest run services/control-api/src/services/ai-router/responses-sweeper.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sweepOnce, startResponsesSweeper } from './responses-sweeper.js';
import type { RuntimeDbConfig } from '../runtime-db.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockPool(rowCount: number) {
  return { query: vi.fn().mockResolvedValue({ rowCount }) };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ── Mock runtime-db so getRuntimeDbPool returns our stub ─────────────────────

vi.mock('../runtime-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime-db.js')>();
  return {
    ...actual,
    getRuntimeDbPool: vi.fn(),
  };
});

import { getRuntimeDbPool } from '../runtime-db.js';

const mockGetPool = getRuntimeDbPool as unknown as ReturnType<typeof vi.fn>;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sweepOnce', () => {
  it('deletes expired rows in a single region and returns deleted count', async () => {
    const mockPool = makeMockPool(5);
    mockGetPool.mockReturnValue(mockPool);

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    const result = await sweepOnce(cfg, logger);

    expect(result.deleted).toBe(5);
    expect(mockPool.query).toHaveBeenCalledOnce();

    // Verify the SQL uses the ctid-safe subquery DELETE pattern and expires_at filter
    const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM ai_responses');
    expect(sql).toContain('WHERE id IN');
    expect(sql).toContain('expires_at < $1');
    expect(sql).toContain('LIMIT $2');
    // First param must be a Unix epoch integer (seconds), not ms
    expect(typeof params[0]).toBe('number');
    expect(params[0]).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });

  it('aggregates deleted counts across multiple regions', async () => {
    const poolA = makeMockPool(3);
    const poolB = makeMockPool(7);
    mockGetPool
      .mockReturnValueOnce(poolA)
      .mockReturnValueOnce(poolB);

    const cfg: RuntimeDbConfig = {
      urlsByRegion: {
        'us-east-1': 'postgres://us...',
        'eu-west-1': 'postgres://eu...',
      },
    };

    const result = await sweepOnce(cfg, logger);

    expect(result.deleted).toBe(10);
    expect(poolA.query).toHaveBeenCalledOnce();
    expect(poolB.query).toHaveBeenCalledOnce();
  });

  it('returns deleted: 0 when no rows are expired', async () => {
    const mockPool = makeMockPool(0);
    mockGetPool.mockReturnValue(mockPool);

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    const result = await sweepOnce(cfg, logger);

    expect(result.deleted).toBe(0);
    // Should not log when nothing was deleted
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ deleted: expect.any(Number) }),
      expect.any(String),
    );
  });

  it('skips a region silently when the table does not exist (42P01)', async () => {
    const err = Object.assign(new Error('relation "ai_responses" does not exist'), { code: '42P01' });
    const mockPool = { query: vi.fn().mockRejectedValue(err) };
    mockGetPool.mockReturnValue(mockPool);

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    const result = await sweepOnce(cfg, logger);

    // Should not throw and should not log an error for this expected case
    expect(result.deleted).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an error and continues for unexpected DB failures', async () => {
    const poolFail = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const poolOk = makeMockPool(2);
    mockGetPool
      .mockReturnValueOnce(poolFail)
      .mockReturnValueOnce(poolOk);

    const cfg: RuntimeDbConfig = {
      urlsByRegion: {
        'us-east-1': 'postgres://bad...',
        'eu-west-1': 'postgres://good...',
      },
    };

    const result = await sweepOnce(cfg, logger);

    expect(result.deleted).toBe(2);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('handles null rowCount gracefully (treats as 0)', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: null }) };
    mockGetPool.mockReturnValue(mockPool);

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    const result = await sweepOnce(cfg, logger);

    expect(result.deleted).toBe(0);
  });
});

describe('startResponsesSweeper (lifecycle)', () => {
  it('starts and stops cleanly', async () => {
    mockGetPool.mockReturnValue(makeMockPool(0));

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    const handle = startResponsesSweeper(cfg, logger, 50);

    // Allow one tick to complete
    await new Promise((res) => setTimeout(res, 80));
    await handle.stop();

    expect(mockGetPool).toHaveBeenCalled();
  });

  it('does not fire after stop is called', async () => {
    mockGetPool.mockReturnValue(makeMockPool(0));

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    const handle = startResponsesSweeper(cfg, logger, 200);
    await handle.stop();

    const callCountAfterStop = mockGetPool.mock.calls.length;

    // Wait well beyond the interval — should not tick again
    await new Promise((res) => setTimeout(res, 300));
    expect(mockGetPool.mock.calls.length).toBe(callCountAfterStop);
  });
});
