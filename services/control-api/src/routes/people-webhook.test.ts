// services/control-api/src/routes/people-webhook.test.ts
// Unit tests for the People email-lookup webhook receiver.
// All external dependencies are mocked — no real database or network.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks (vi.mock is hoisted by vitest before imports) ────────────────

vi.mock('../services/runtime-pool-registry.js', () => ({
  listRuntimeRegions: vi.fn(() => ['local']),
  runtimePoolFor: vi.fn(),
}));

vi.mock('../services/usage-metering.js', () => ({
  deductCreditsBalance: vi.fn(),
  incrementUsage: vi.fn(),
}));

vi.mock('../services/people/pricing.js', () => ({
  getPeoplePricing: vi.fn(() => ({
    baseUsdPerCredit: 0.0168,
    markupPct: 20,
    usdPerCredit: 0.02016,
  })),
}));

vi.mock('../config.js', () => ({
  config: {
    people: {
      enabled: true,
      emailLookupCredits: 1,
    },
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { peopleWebhookRoutes } from './people-webhook.js';
import { listRuntimeRegions, runtimePoolFor } from '../services/runtime-pool-registry.js';
import { deductCreditsBalance, incrementUsage } from '../services/usage-metering.js';
import { getPeoplePricing } from '../services/people/pricing.js';
import { config } from '../config.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const NONCE = 'a'.repeat(64); // 64-char hex nonce (simulated)
const LOOKUP_ID = 'lookup-uuid-1';
const APP_ID = 'app_test123';
const USER_ID = 'user-uuid-1';
const NORMALIZED_URL = 'https://www.linkedin.com/in/jane-doe';
const USD_PER_CREDIT = 0.02016;

const SAMPLE_LOOKUP_ROW = {
  id: LOOKUP_ID,
  app_id: APP_ID,
  user_id: USER_ID,
  normalized_url: NORMALIZED_URL,
};

// ── Pool factory ──────────────────────────────────────────────────────────────

/**
 * Creates a mock pg.Pool whose query() dispatches on SQL shape.
 *
 * @param opts.findRow      - The row returned by the nonce SELECT.  null = unknown nonce.
 * @param opts.claimRows    - Rows returned by the atomic UPDATE claim.  [] = already claimed.
 * @param opts.failClaim    - If true, the UPDATE throws (simulates DB error).
 */
function makeRuntimePool({
  findRow = SAMPLE_LOOKUP_ROW as typeof SAMPLE_LOOKUP_ROW | null,
  claimRows = [{ status: 'resolved', key_type: 'platform' }] as { status: string; key_type: string }[],
  failClaim = false,
} = {}) {
  const queryFn = vi.fn().mockImplementation((sql: string) => {
    // Nonce lookup
    if (sql.includes('WHERE nonce =')) {
      if (findRow === null) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [findRow], rowCount: 1 });
    }
    // Atomic claim update
    if (sql.includes("status = 'pending'") || (sql.startsWith('UPDATE') && sql.includes('RETURNING status'))) {
      if (failClaim) return Promise.reject(new Error('DB claim error'));
      return Promise.resolve({ rows: claimRows, rowCount: claimRows.length });
    }
    // Audit log insert (or any other query)
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return { query: queryFn };
}

// ── Test app builder ──────────────────────────────────────────────────────────

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Decorate controlDb so deductCreditsBalance(app.controlDb, …) doesn't crash.
  app.decorate('controlDb', {} as any);
  await app.register(peopleWebhookRoutes);
  await app.ready();
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /v1/webhooks/people/email', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset pricing mock implementation so a per-test throw doesn't bleed into later tests.
    vi.mocked(getPeoplePricing).mockReturnValue({
      baseUsdPerCredit: 0.0168,
      markupPct: 20,
      usdPerCredit: USD_PER_CREDIT,
    });
    app = await buildTestApp();
    vi.mocked(listRuntimeRegions).mockReturnValue(['local']);
  });

  afterEach(async () => {
    await app?.close();
  });

  // ── Scenario 1: valid nonce + email present ───────────────────────────────
  it('1. valid nonce + email present → resolved, credits deducted, audit written, 200 { ok: true }', async () => {
    const pool = makeRuntimePool({ claimRows: [{ status: 'resolved', key_type: 'platform' }] });
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);
    vi.mocked(deductCreditsBalance).mockResolvedValue(1 * USD_PER_CREDIT);
    vi.mocked(incrementUsage).mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/people/email?nonce=${NONCE}`,
      payload: { email: 'jane@example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // credits deducted
    expect(deductCreditsBalance).toHaveBeenCalledWith(
      expect.anything(), // controlDb
      USER_ID,
      1 * USD_PER_CREDIT, // 1 credit × USD_PER_CREDIT
    );
    expect(incrementUsage).toHaveBeenCalledWith(USER_ID, 'people_credits', 1, APP_ID);

    // audit log written
    const auditCall = pool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('people_usage_logs'),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1]).toContain('profile_email_resolved');
    expect(auditCall![1]).toContain('platform');

    // UPDATE claim call happened
    const claimCall = pool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).startsWith('UPDATE'),
    );
    expect(claimCall).toBeDefined();
    expect(claimCall![1]).toContain('resolved'); // status='resolved' (email found)
    expect(claimCall![1]).toContain('jane@example.com');
  });

  // ── Scenario 2: valid nonce + null email (vendor lookup failed) ───────────
  it('2. valid nonce + null email → failed row, $0 charge, no deductCreditsBalance, audit action=profile_email_failed', async () => {
    const pool = makeRuntimePool({ claimRows: [{ status: 'failed', key_type: 'platform' }] });
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/people/email?nonce=${NONCE}`,
      payload: { email: null }, // null email = lookup failed at vendor
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // No credit charge for failed lookups
    expect(deductCreditsBalance).not.toHaveBeenCalled();
    expect(incrementUsage).not.toHaveBeenCalled();

    // UPDATE claim sets status='failed'
    const claimCall = pool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).startsWith('UPDATE'),
    );
    expect(claimCall).toBeDefined();
    expect(claimCall![1][0]).toBe('failed');
    expect(claimCall![1][1]).toBeNull(); // email param is null

    // Audit row written with usd_cost=0 and usd_charged=0 and action='profile_email_failed'
    const auditCall = pool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('people_usage_logs'),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1]).toContain(0); // usd_cost = 0
    expect(auditCall![1]).toContain('profile_email_failed');
  });

  // ── Scenario 3: unknown nonce ─────────────────────────────────────────────
  it('3. unknown nonce → 200 { ignored: true }, no UPDATE or audit writes', async () => {
    const pool = makeRuntimePool({ findRow: null });
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/people/email?nonce=unknown-nonce`,
      payload: { email: 'jane@example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ignored: true });

    // Only the SELECT was called
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toMatch(/WHERE nonce/);

    // No metering
    expect(deductCreditsBalance).not.toHaveBeenCalled();
    expect(incrementUsage).not.toHaveBeenCalled();
  });

  // ── Scenario 4: already-resolved nonce (idempotent) ──────────────────────
  it('4. already-resolved nonce → 200 { ignored: true }, no second deduction', async () => {
    // UPDATE-WHERE-pending returns 0 rows (row is already resolved/failed).
    const pool = makeRuntimePool({ claimRows: [] });
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/people/email?nonce=${NONCE}`,
      payload: { email: 'jane@example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ignored: true });

    expect(deductCreditsBalance).not.toHaveBeenCalled();
    expect(incrementUsage).not.toHaveBeenCalled();
  });

  // ── Scenario 5: concurrent same-nonce (second call hits resolved row) ─────
  it('5. concurrent same-nonce: second call claims 0 rows → ignored, no double charge', async () => {
    // Simulate: first call already claimed the row.  Second call sees claimRows=[].
    let callCount = 0;
    const queryFn = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('WHERE nonce =')) {
        // Both calls find the row by nonce
        return Promise.resolve({ rows: [SAMPLE_LOOKUP_ROW], rowCount: 1 });
      }
      if (sql.startsWith('UPDATE')) {
        callCount++;
        // First call → claims successfully; second call → 0 rows (already claimed)
        const rows = callCount === 1 ? [{ status: 'resolved', key_type: 'platform' }] : [];
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const pool = { query: queryFn };
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);
    vi.mocked(deductCreditsBalance).mockResolvedValue(1 * USD_PER_CREDIT);
    vi.mocked(incrementUsage).mockResolvedValue(undefined);

    const url = `/v1/webhooks/people/email?nonce=${NONCE}`;
    const payload = { email: 'jane@example.com' };

    const res1 = await app.inject({ method: 'POST', url, payload });
    const res2 = await app.inject({ method: 'POST', url, payload });

    expect(res1.statusCode).toBe(200);
    expect(res1.json()).toEqual({ ok: true });

    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({ ignored: true });

    // Credits deducted exactly once
    expect(deductCreditsBalance).toHaveBeenCalledTimes(1);
    expect(incrementUsage).toHaveBeenCalledTimes(1);
  });

  // ── Scenario 6: malformed / missing body ─────────────────────────────────
  it('6. null/missing body → 200 { ignored: true }, no crash, no DB writes', async () => {
    const pool = makeRuntimePool();
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);

    // Inject with no payload — req.body will be null in Fastify
    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/people/email?nonce=${NONCE}`,
      // no payload → req.body = null
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ignored: true });

    // No DB queries at all (null body short-circuits before DB)
    expect(pool.query).not.toHaveBeenCalled();
    expect(deductCreditsBalance).not.toHaveBeenCalled();
  });

  // ── Scenario 7: missing nonce query param ─────────────────────────────────
  it('7. missing nonce → 200 { ignored: true }, no DB queries', async () => {
    const pool = makeRuntimePool();
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/people/email', // no ?nonce=
      payload: { email: 'jane@example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ignored: true });

    // runtimePoolFor not even called (early return before pool access)
    expect(runtimePoolFor).not.toHaveBeenCalled();
    expect(deductCreditsBalance).not.toHaveBeenCalled();
  });

  // ── Scenario 8: runtimePoolFor throws → 200 { ignored: true }, no DB writes
  it('8. runtimePoolFor throws → 200 { ignored: true }, no DB writes', async () => {
    vi.mocked(runtimePoolFor).mockImplementation(() => {
      throw new Error('pool not initialized for region local');
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/people/email?nonce=${NONCE}`,
      payload: { email: 'jane@example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ignored: true });

    // No metering attempted
    expect(deductCreditsBalance).not.toHaveBeenCalled();
    expect(incrementUsage).not.toHaveBeenCalled();
  });

  // ── Scenario 9: pricing throws after claim → 200 { ok: true, billing: 'deferred' }
  it('9. pricing throws after claim → 200 { ok: true, billing: "deferred" }, no deduct call', async () => {
    const pool = makeRuntimePool({ claimRows: [{ status: 'resolved', key_type: 'platform' }] });
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);
    vi.mocked(getPeoplePricing).mockImplementation(() => {
      throw new Error('pricing config missing');
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/people/email?nonce=${NONCE}`,
      payload: { email: 'jane@example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, billing: 'deferred' });

    // Claim UPDATE was called (row is resolved) but deduction was not attempted
    const claimCall = pool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).startsWith('UPDATE'),
    );
    expect(claimCall).toBeDefined();

    expect(deductCreditsBalance).not.toHaveBeenCalled();
    expect(incrementUsage).not.toHaveBeenCalled();
  });

  // ── Scenario 10: BYOK row → no deductCreditsBalance, audit has usd_charged=0 + key_type='byok'
  it('10. BYOK row (key_type="byok") → claim resolves, NO deductCreditsBalance, audit usd_charged=0 key_type=byok', async () => {
    const pool = makeRuntimePool({ claimRows: [{ status: 'resolved', key_type: 'byok' }] });
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);
    vi.mocked(deductCreditsBalance).mockResolvedValue(0);
    vi.mocked(incrementUsage).mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/people/email?nonce=${NONCE}`,
      payload: { email: 'jane@example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // BYOK: Butterbase should NOT deduct credits
    expect(deductCreditsBalance).not.toHaveBeenCalled();
    expect(incrementUsage).not.toHaveBeenCalled();

    // Audit row must record key_type='byok' and usd_charged=0
    const auditCall = pool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).includes('people_usage_logs'),
    );
    expect(auditCall).toBeDefined();
    const auditParams = auditCall![1] as unknown[];
    expect(auditParams).toContain('byok');
    // usd_cost and usd_charged both 0 for BYOK
    const zeroCount = auditParams.filter((v) => v === 0).length;
    expect(zeroCount).toBeGreaterThanOrEqual(2); // usd_cost=0, usd_charged=0
  });

  // ── Additional: work_email fallback field ─────────────────────────────────
  it('work_email field is accepted as email', async () => {
    const pool = makeRuntimePool({ claimRows: [{ status: 'resolved', key_type: 'platform' }] });
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);
    vi.mocked(deductCreditsBalance).mockResolvedValue(1 * USD_PER_CREDIT);
    vi.mocked(incrementUsage).mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/people/email?nonce=${NONCE}`,
      payload: { work_email: 'jane.work@example.com' }, // no 'email' field
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const claimCall = pool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).startsWith('UPDATE'),
    );
    expect(claimCall![1][1]).toBe('jane.work@example.com');
  });

  // ── Additional: result.email nested field ─────────────────────────────────
  it('result.email nested field is accepted as email', async () => {
    const pool = makeRuntimePool({ claimRows: [{ status: 'resolved', key_type: 'platform' }] });
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);
    vi.mocked(deductCreditsBalance).mockResolvedValue(1 * USD_PER_CREDIT);
    vi.mocked(incrementUsage).mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/people/email?nonce=${NONCE}`,
      payload: { result: { email: 'jane.nested@example.com' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const claimCall = pool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).startsWith('UPDATE'),
    );
    expect(claimCall![1][1]).toBe('jane.nested@example.com');
  });

  // ── Feature flag disabled → 200 { ignored: true } ────────────────────────
  it('feature flag disabled → 200 { ignored: true } (People must see 200s)', async () => {
    const pool = makeRuntimePool();
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);

    const originalEnabled = config.people.enabled;
    (config.people as any).enabled = false;

    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/webhooks/people/email?nonce=${NONCE}`,
        payload: { email: 'jane@example.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ignored: true });

      // No DB queries at all — flag check short-circuits before pool access
      expect(runtimePoolFor).not.toHaveBeenCalled();
      expect(deductCreditsBalance).not.toHaveBeenCalled();
    } finally {
      (config.people as any).enabled = originalEnabled;
    }
  });

  // ── Additional: x-enrichlayer-credit-cost header overrides default ─────────
  it('x-enrichlayer-credit-cost header is used when present', async () => {
    const pool = makeRuntimePool({ claimRows: [{ status: 'resolved', key_type: 'platform' }] });
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);
    vi.mocked(deductCreditsBalance).mockResolvedValue(5 * USD_PER_CREDIT);
    vi.mocked(incrementUsage).mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/people/email?nonce=${NONCE}`,
      payload: { email: 'jane@example.com' },
      headers: { 'x-enrichlayer-credit-cost': '5' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    expect(deductCreditsBalance).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      5 * USD_PER_CREDIT, // 5 credits from header
    );
    expect(incrementUsage).toHaveBeenCalledWith(USER_ID, 'people_credits', 5, APP_ID);
  });
});
