/**
 * Unit tests for the stuck-pending people_email_lookups sweeper.
 *
 * All DB interaction is mocked — no live database needed.
 *
 * Run with:
 *   npx vitest run services/control-api/src/services/people/email-lookup-sweeper.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sweepOnce, startEmailLookupSweeper, PENDING_TTL_HOURS } from './email-lookup-sweeper.js';
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

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sweepOnce', () => {
  it('expires stuck pending rows in a single region and returns the count', async () => {
    const mockPool = makeMockPool(4);
    mockGetPool.mockReturnValue(mockPool);

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    const result = await sweepOnce(cfg, logger);

    expect(result.expired).toBe(4);
    expect(mockPool.query).toHaveBeenCalledOnce();
  });

  it('only targets pending rows older than the TTL, in a bounded batch', async () => {
    const mockPool = makeMockPool(1);
    mockGetPool.mockReturnValue(mockPool);

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    await sweepOnce(cfg, logger);

    const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE people_email_lookups');
    expect(sql).toContain("SET status = 'expired'");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('requested_at <');
    expect(sql).toContain('LIMIT');
    // TTL is passed as a parameter (hours), not interpolated
    expect(params[0]).toBe(PENDING_TTL_HOURS);
  });

  it('writes a zero-cost profile_email_expired audit row for every swept lookup', async () => {
    const mockPool = makeMockPool(2);
    mockGetPool.mockReturnValue(mockPool);

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    await sweepOnce(cfg, logger);

    const [sql] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO people_usage_logs');
    expect(sql).toContain('profile_email_expired');
    // No refund: the audit row records the expiry at zero, it does not credit back.
    expect(sql).not.toMatch(/deduct|refund|credit_balance/i);
  });

  it('carries org, user and provider attribution onto the audit row', async () => {
    const mockPool = makeMockPool(1);
    mockGetPool.mockReturnValue(mockPool);

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    await sweepOnce(cfg, logger);

    const [sql] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('organization_id');
    expect(sql).toContain('user_id');
    expect(sql).toContain('provider_slot');
    expect(sql).toContain('key_type');
  });

  it('aggregates expired counts across multiple regions', async () => {
    const poolA = makeMockPool(3);
    const poolB = makeMockPool(7);
    mockGetPool.mockReturnValueOnce(poolA).mockReturnValueOnce(poolB);

    const cfg: RuntimeDbConfig = {
      urlsByRegion: {
        'us-east-1': 'postgres://us...',
        'us-west-2': 'postgres://west...',
      },
    };

    const result = await sweepOnce(cfg, logger);

    expect(result.expired).toBe(10);
    expect(poolA.query).toHaveBeenCalledOnce();
    expect(poolB.query).toHaveBeenCalledOnce();
  });

  it('returns expired: 0 and stays quiet when nothing is stuck', async () => {
    const mockPool = makeMockPool(0);
    mockGetPool.mockReturnValue(mockPool);

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    const result = await sweepOnce(cfg, logger);

    expect(result.expired).toBe(0);
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ expired: expect.any(Number) }),
      expect.any(String),
    );
  });

  it('skips a region silently when the table does not exist (42P01)', async () => {
    const err = Object.assign(new Error('relation "people_email_lookups" does not exist'), {
      code: '42P01',
    });
    const mockPool = { query: vi.fn().mockRejectedValue(err) };
    mockGetPool.mockReturnValue(mockPool);

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    const result = await sweepOnce(cfg, logger);

    expect(result.expired).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an error and continues to the next region on an unexpected DB failure', async () => {
    const poolFail = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const poolOk = makeMockPool(2);
    mockGetPool.mockReturnValueOnce(poolFail).mockReturnValueOnce(poolOk);

    const cfg: RuntimeDbConfig = {
      urlsByRegion: {
        'us-east-1': 'postgres://bad...',
        'us-west-2': 'postgres://good...',
      },
    };

    const result = await sweepOnce(cfg, logger);

    expect(result.expired).toBe(2);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('handles null rowCount gracefully (treats as 0)', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rowCount: null }) };
    mockGetPool.mockReturnValue(mockPool);

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    const result = await sweepOnce(cfg, logger);

    expect(result.expired).toBe(0);
  });
});

describe('startEmailLookupSweeper (lifecycle)', () => {
  it('starts and stops cleanly', async () => {
    mockGetPool.mockReturnValue(makeMockPool(0));

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    const handle = startEmailLookupSweeper(cfg, logger, 50);

    await new Promise((res) => setTimeout(res, 80));
    await handle.stop();

    expect(mockGetPool).toHaveBeenCalled();
  });

  it('does not fire after stop is called', async () => {
    mockGetPool.mockReturnValue(makeMockPool(0));

    const cfg: RuntimeDbConfig = { urlsByRegion: { 'us-east-1': 'postgres://...' } };
    const handle = startEmailLookupSweeper(cfg, logger, 200);
    await handle.stop();

    const callCountAfterStop = mockGetPool.mock.calls.length;

    await new Promise((res) => setTimeout(res, 300));
    expect(mockGetPool.mock.calls.length).toBe(callCountAfterStop);
  });
});
