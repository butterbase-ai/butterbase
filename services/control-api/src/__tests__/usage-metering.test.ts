/**
 * usage-metering.test.ts
 *
 * Verifies that all usage_meters INSERTs include organization_id after the
 * Plan 07.1 patch. Uses mock pools to intercept SQL without needing a full
 * multi-region runtime-DB setup, plus a real controlDb to exercise
 * resolveOrganizationId end-to-end.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// ── hoisted mock state (available before vi.mock factories run) ───────────────
const { capturedInsertsRef, mockQueryFn } = vi.hoisted(() => {
  const capturedInsertsRef: Array<{ sql: string; params: unknown[] }>[] = [[]];
  const defaultImpl = async (sql: string, params: unknown[]) => {
    if (typeof sql === 'string' && sql.includes('INSERT INTO usage_meters')) {
      capturedInsertsRef[0]!.push({ sql, params });
      return { rows: [] };
    }
    if (typeof sql === 'string' && sql.includes('storage_objects')) {
      return { rows: [{ app_id: 'test-app-id', total: '512' }] };
    }
    return { rows: [] };
  };
  const mockQueryFn = vi.fn().mockImplementation(defaultImpl);
  return { capturedInsertsRef, mockQueryFn };
});

// ── mock redis ────────────────────────────────────────────────────────────────
vi.mock('../services/redis.js', () => ({
  getRedisClient: () => ({
    get: vi.fn().mockResolvedValue(null),
    getdel: vi.fn().mockResolvedValue(null),
    keys: vi.fn().mockResolvedValue([]),
    set: vi.fn(),
    expire: vi.fn(),
    incrby: vi.fn(),
    setex: vi.fn().mockResolvedValue('OK'),
  }),
}));

// ── mock config to expose a single fake region ────────────────────────────────
vi.mock('../config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config.js')>();
  return {
    ...original,
    config: {
      ...original.config,
      runtimeDb: { urlsByRegion: { 'us-east-1': 'unused' } },
    },
  };
});

// ── mock runtime-db and region-resolver to use our hoisted mock ───────────────
vi.mock('../services/runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn().mockImplementation(() => ({ query: mockQueryFn })),
}));

vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn().mockResolvedValue({ query: mockQueryFn }),
}));

// ── real controlDb for resolveOrganizationId integration ─────────────────────
import { controlDb, seedUser, setupTestDb } from './test-helpers/control-db.js';
import { reconcileUsage } from '../services/usage-metering.js';

describe('usage-metering — organization_id stamping', () => {
  let userId: string;
  let personalOrgId: string;

  beforeAll(async () => {
    await setupTestDb();
    ({ id: userId, personalOrgId } = await seedUser('meter-test@x.com'));
  });

  afterAll(async () => {
    await controlDb.end();
  });

  beforeEach(() => {
    capturedInsertsRef[0] = [];
    mockQueryFn.mockClear();
    mockQueryFn.mockImplementation(async (sql: string, params: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO usage_meters')) {
        capturedInsertsRef[0]!.push({ sql, params });
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.includes('storage_objects')) {
        return { rows: [{ app_id: 'test-app-id', total: '512' }] };
      }
      return { rows: [] };
    });
  });

  it('fresh insert stamps organization_id in the params', async () => {
    await reconcileUsage(controlDb, userId, '2026-07-01');

    const inserts = capturedInsertsRef[0]!;
    expect(inserts.length).toBeGreaterThan(0);
    const ins = inserts[0]!;
    // params order: [userId, organizationId, appId, periodStart, total]
    expect(ins.params[0]).toBe(userId);
    expect(ins.params[1]).toBe(personalOrgId);
    expect(ins.sql).toContain('organization_id');
  });

  it('on-conflict update: organization_id is present in every INSERT emission', async () => {
    // Call twice — second would trigger ON CONFLICT in a real DB
    await reconcileUsage(controlDb, userId, '2026-07-01');
    await reconcileUsage(controlDb, userId, '2026-07-01');

    const inserts = capturedInsertsRef[0]!;
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    for (const ins of inserts) {
      expect(ins.sql).toContain('organization_id');
      expect(ins.params[1]).toBe(personalOrgId);
    }
  });

  it('INSERT for a known user with a specific app_id still resolves organization_id', async () => {
    const specificAppId = 'specific-app-abc';
    mockQueryFn.mockImplementation(async (sql: string, params: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO usage_meters')) {
        capturedInsertsRef[0]!.push({ sql, params });
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.includes('storage_objects')) {
        return { rows: [{ app_id: specificAppId, total: '2048' }] };
      }
      return { rows: [] };
    });

    await reconcileUsage(controlDb, userId, '2026-07-01');

    const inserts = capturedInsertsRef[0]!;
    expect(inserts.length).toBeGreaterThan(0);
    const ins = inserts[0]!;
    expect(ins.params[1]).toBe(personalOrgId);    // organization_id at position 2
    expect(ins.params[2]).toBe(specificAppId);    // app_id at position 3
  });

  it('unknown-user path throws (resolveOrganizationId propagates the error)', async () => {
    const bogusId = '00000000-0000-0000-0000-000000000000';
    await expect(reconcileUsage(controlDb, bogusId, '2026-07-01'))
      .rejects.toThrow(/not found/);
  });
});
