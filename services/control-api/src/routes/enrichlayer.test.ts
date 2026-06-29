// services/control-api/src/routes/enrichlayer.test.ts
// Unit tests for EnrichLayer routes. All external dependencies are mocked —
// no real database or network connections required.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// ── Module mocks (vi.mock is hoisted by vitest before imports) ───────────────

vi.mock('../services/enrichlayer/registry.js', () => ({
  getEnrichLayerAdapter: vi.fn(),
}));

vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(),
}));

vi.mock('../services/enrichlayer/cache.js', () => ({
  lookupCachedProfile: vi.fn(),
  writeCachedProfile: vi.fn(),
}));

vi.mock('../services/enrichlayer/byok-crypto.js', () => ({
  encryptByok: vi.fn((k: string) => `enc:${k}`),
  decryptByok: vi.fn((k: string) => k.replace(/^enc:/, '')),
}));

vi.mock('../services/usage-metering.js', () => ({
  getCreditsBalance: vi.fn(),
  deductCreditsBalance: vi.fn(),
  incrementUsage: vi.fn(),
}));

vi.mock('../services/enrichlayer/pricing.js', () => ({
  getEnrichLayerPricing: vi.fn(() => ({
    baseUsdPerCredit: 0.0168,
    markupPct: 20,
    usdPerCredit: 0.02016,
  })),
}));

vi.mock('../config.js', () => ({
  config: {
    enrichlayer: {
      apiKey: 'platform-key',
      minBalanceUsd: 0.05,
      webhookHostUrl: 'https://api.butterbase.ai',
    },
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { enrichLayerRoutes } from './enrichlayer.js';
import { getEnrichLayerAdapter } from '../services/enrichlayer/registry.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { lookupCachedProfile, writeCachedProfile } from '../services/enrichlayer/cache.js';
import { decryptByok } from '../services/enrichlayer/byok-crypto.js';
import { getCreditsBalance, deductCreditsBalance, incrementUsage } from '../services/usage-metering.js';
import type { EnrichLayerAdapter, ProfilePayload } from '../services/enrichlayer/types.js';

// ── Constants ────────────────────────────────────────────────────────────────

const APP_ID = 'app_test123';
const USER_ID = 'u1';
const PLATFORM_KEY = 'platform-key';
const USD_PER_CREDIT = 0.02016;

const SAMPLE_PROFILE: ProfilePayload = {
  publicIdentifier: 'jane-doe',
  firstName: 'Jane',
  lastName: 'Doe',
  fullName: 'Jane Doe',
  headline: 'CTO',
  occupation: null,
  summary: null,
  city: 'SF',
  state: 'CA',
  country: 'US',
  experiences: [],
  education: [],
  raw: {},
};

// ── Factory helpers ──────────────────────────────────────────────────────────

/** Make a minimal mock runtime pg.Pool whose query() is a vi.fn() */
function makeMockRuntime(byokEncrypted: string | null = null) {
  const runtimeQuery = vi.fn().mockImplementation((sql: string, params: unknown[]) => {
    if (typeof sql === 'string' && sql.includes('enrichlayer_byok_key_encrypted') && sql.startsWith('SELECT')) {
      return Promise.resolve({ rows: [{ enrichlayer_byok_key_encrypted: byokEncrypted }], rowCount: 1 });
    }
    if (typeof sql === 'string' && sql.includes('enrichlayer_email_lookups') && sql.includes('INSERT')) {
      return Promise.resolve({ rows: [{ id: 'lookup-abc' }], rowCount: 1 });
    }
    if (typeof sql === 'string' && sql.includes('enrichlayer_email_lookups') && sql.includes('SELECT')) {
      return Promise.resolve({
        rows: [{ status: 'pending', email: null, credits_consumed: 0 }],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return { query: runtimeQuery } as any;
}

/** Make a minimal mock adapter whose methods are vi.fn() */
function makeMockAdapter(overrides: Partial<EnrichLayerAdapter> = {}): EnrichLayerAdapter {
  return {
    searchPerson: vi.fn().mockResolvedValue({
      data: { results: [], nextPage: null, totalResultCount: 0 },
      creditsConsumed: 6,
      requestId: 'req-1',
      status: 200,
    }),
    searchCompany: vi.fn().mockResolvedValue({
      data: { results: [], nextPage: null, totalResultCount: 0 },
      creditsConsumed: 3,
      requestId: 'req-2',
      status: 200,
    }),
    getProfile: vi.fn().mockResolvedValue({
      data: SAMPLE_PROFILE,
      creditsConsumed: 1,
      requestId: 'req-3',
      status: 200,
      notFound: false,
    }),
    queueEmailLookup: vi.fn().mockResolvedValue({
      data: { queued: true },
      creditsConsumed: 0,
      requestId: 'req-4',
      status: 200,
    }),
    getCreditBalance: vi.fn().mockResolvedValue({
      data: { balance: 42 },
      creditsConsumed: 0,
      requestId: null,
      status: 200,
    }),
    ...overrides,
  };
}

/** Build a test Fastify app with auth stubbed and controlDb mocked */
async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('auth', null as any);
  app.addHook('onRequest', async (request) => {
    (request as any).auth = { userId: USER_ID, authMethod: 'api_key', scopes: ['*'] };
  });
  // Provide a controlDb decoration so usage-metering mocks can receive it
  app.decorate('controlDb', {} as any);
  await app.register(enrichLayerRoutes);
  await app.ready();
  return app;
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('EnrichLayer routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── Scenario 1: search/person platform key → metering + audit + deduct ────
  describe('POST /v1/:appId/enrichlayer/search/person — platform key', () => {
    it('calls adapter, deducts credits, increments usage, writes audit row', async () => {
      const mockRuntime = makeMockRuntime(null); // no BYOK
      const mockAdapter = makeMockAdapter(); // creditsConsumed=6
      vi.mocked(getEnrichLayerAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 1.0, totalUsd: 1.0 });
      vi.mocked(deductCreditsBalance).mockResolvedValue(6 * USD_PER_CREDIT);
      vi.mocked(incrementUsage).mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/enrichlayer/search/person`,
        payload: { currentRoleTitle: 'CTO' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.usage.creditsConsumed).toBe(6);
      expect(body.usage.usdCost).toBeCloseTo(6 * USD_PER_CREDIT);

      // Metering
      expect(deductCreditsBalance).toHaveBeenCalledWith(
        expect.anything(),
        USER_ID,
        6 * USD_PER_CREDIT,
      );
      expect(incrementUsage).toHaveBeenCalledWith(USER_ID, 'enrichlayer_credits', 6, APP_ID);

      // Audit row
      const auditCall = mockRuntime.query.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('enrichlayer_usage_logs'),
      );
      expect(auditCall).toBeDefined();
      expect(auditCall![1]).toContain('search_person');
    });
  });

  // ── Scenario 2: profile cache hit → adapter NOT called ────────────────────
  describe('POST /v1/:appId/enrichlayer/profile — cache hit', () => {
    it('serves from cache, adapter not called, audit action=profile_cache_hit, no charge', async () => {
      const mockRuntime = makeMockRuntime(null);
      const mockAdapter = makeMockAdapter();
      vi.mocked(getEnrichLayerAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(lookupCachedProfile).mockResolvedValue({ status: 'ok', payload: SAMPLE_PROFILE });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/enrichlayer/profile`,
        payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/jane-doe' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.usage.cached).toBe(true);
      expect(body.usage.creditsConsumed).toBe(0);
      expect(body.usage.usdCost).toBe(0);

      // Adapter NOT called
      expect(mockAdapter.getProfile).not.toHaveBeenCalled();

      // No charge
      expect(deductCreditsBalance).not.toHaveBeenCalled();
      expect(incrementUsage).not.toHaveBeenCalled();

      // Audit row: action='profile_cache_hit'
      const auditCall = mockRuntime.query.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('enrichlayer_usage_logs'),
      );
      expect(auditCall).toBeDefined();
      expect(auditCall![1]).toContain('profile_cache_hit');
      expect(auditCall![1]).toContain(0); // credits_consumed = 0
    });
  });

  // ── Scenario 3: profile cache miss + ok → adapter called, cache written ───
  describe('POST /v1/:appId/enrichlayer/profile — cache miss ok', () => {
    it('calls adapter, writes ok cache, charges user', async () => {
      const mockRuntime = makeMockRuntime(null);
      const mockAdapter = makeMockAdapter({
        getProfile: vi.fn().mockResolvedValue({
          data: SAMPLE_PROFILE,
          creditsConsumed: 5,
          requestId: 'req-3',
          status: 200,
          notFound: false,
        }),
      });
      vi.mocked(getEnrichLayerAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(lookupCachedProfile).mockResolvedValue(null); // cache miss
      vi.mocked(writeCachedProfile).mockResolvedValue(undefined);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 1.0, totalUsd: 1.0 });
      vi.mocked(deductCreditsBalance).mockResolvedValue(5 * USD_PER_CREDIT);
      vi.mocked(incrementUsage).mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/enrichlayer/profile`,
        payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/jane-doe' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('ok');
      expect(body.usage.cached).toBe(false);

      // Cache written with status='ok'
      expect(writeCachedProfile).toHaveBeenCalledWith(
        mockRuntime,
        APP_ID,
        'https://www.linkedin.com/in/jane-doe',
        'ok',
        SAMPLE_PROFILE,
      );

      // Charged
      expect(deductCreditsBalance).toHaveBeenCalledWith(expect.anything(), USER_ID, 5 * USD_PER_CREDIT);
      expect(incrementUsage).toHaveBeenCalledWith(USER_ID, 'enrichlayer_credits', 5, APP_ID);
    });
  });

  // ── Scenario 4: profile cache miss + not_found → cache written, $0 charge ─
  describe('POST /v1/:appId/enrichlayer/profile — cache miss not_found', () => {
    it('writes not_found cache, no charge', async () => {
      const mockRuntime = makeMockRuntime(null);
      const mockAdapter = makeMockAdapter({
        getProfile: vi.fn().mockResolvedValue({
          data: null,
          creditsConsumed: 0,
          requestId: 'req-3',
          status: 404,
          notFound: true,
        }),
      });
      vi.mocked(getEnrichLayerAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(lookupCachedProfile).mockResolvedValue(null);
      vi.mocked(writeCachedProfile).mockResolvedValue(undefined);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 1.0, totalUsd: 1.0 });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/enrichlayer/profile`,
        payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/jane-doe' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('not_found');

      // Cache written with status='not_found' (7d TTL is in writeCachedProfile)
      expect(writeCachedProfile).toHaveBeenCalledWith(
        mockRuntime,
        APP_ID,
        'https://www.linkedin.com/in/jane-doe',
        'not_found',
        null,
      );

      // No charge when creditsConsumed=0
      expect(deductCreditsBalance).not.toHaveBeenCalled();
      expect(incrementUsage).not.toHaveBeenCalled();
    });
  });

  // ── Scenario 5: BYOK → balance gate skipped, no charge, key_type=byok ─────
  describe('POST /v1/:appId/enrichlayer/search/person — BYOK key', () => {
    it('skips balance check, no deduct, audit row has key_type=byok', async () => {
      const byokEncrypted = 'enc:my-byok-key';
      const mockRuntime = makeMockRuntime(byokEncrypted);
      const mockAdapter = makeMockAdapter();
      vi.mocked(getEnrichLayerAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(decryptByok).mockReturnValue('my-byok-key');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/enrichlayer/search/person`,
        payload: { currentRoleTitle: 'CTO' },
      });

      expect(res.statusCode).toBe(200);

      // Balance check NOT called (BYOK path)
      expect(getCreditsBalance).not.toHaveBeenCalled();
      // No deduction
      expect(deductCreditsBalance).not.toHaveBeenCalled();
      expect(incrementUsage).not.toHaveBeenCalled();

      // Adapter called with the BYOK key
      expect(mockAdapter.searchPerson).toHaveBeenCalledWith(
        expect.anything(),
        { apiKey: 'my-byok-key' },
      );

      // Audit row with key_type='byok' and usd_charged=0
      const auditCall = mockRuntime.query.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('enrichlayer_usage_logs'),
      );
      expect(auditCall).toBeDefined();
      const auditParams = auditCall![1] as unknown[];
      expect(auditParams).toContain('byok');
      expect(auditParams).toContain(0); // usd_charged
    });
  });

  // ── Scenario 6: insufficient balance → 402, adapter not called ────────────
  describe('POST /v1/:appId/enrichlayer/search/person — low balance', () => {
    it('returns 402 and does not call the adapter', async () => {
      const mockRuntime = makeMockRuntime(null);
      const mockAdapter = makeMockAdapter();
      vi.mocked(getEnrichLayerAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 0.01, totalUsd: 0.01 });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/enrichlayer/search/person`,
        payload: { currentRoleTitle: 'CEO' },
      });

      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ error: 'insufficient_credits' });

      // Adapter NOT called
      expect(mockAdapter.searchPerson).not.toHaveBeenCalled();
    });
  });

  // ── Scenario 7: profile/email → pending row, nonce in callbackUrl ─────────
  describe('POST /v1/:appId/enrichlayer/profile/email', () => {
    it('inserts pending row, calls adapter with nonce in callbackUrl, returns lookupId', async () => {
      const mockRuntime = makeMockRuntime(null);
      const mockAdapter = makeMockAdapter();
      vi.mocked(getEnrichLayerAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 1.0, totalUsd: 1.0 });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/enrichlayer/profile/email`,
        payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/jane-doe' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.lookupId).toBe('lookup-abc');
      expect(body.status).toBe('pending');

      // Verify the INSERT into enrichlayer_email_lookups happened before adapter call
      const insertCall = mockRuntime.query.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('enrichlayer_email_lookups') && (c[0] as string).includes('INSERT'),
      );
      expect(insertCall).toBeDefined();

      // The nonce in the INSERT params matches the nonce in the callbackUrl passed to adapter
      const insertParams = insertCall![1] as string[];
      const nonce = insertParams[3]; // [appId, userId, normalizedUrl, nonce]
      expect(nonce).toMatch(/^[0-9a-f]{64}$/); // 32 bytes = 64 hex chars

      expect(mockAdapter.queueEmailLookup).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackUrl: `https://api.butterbase.ai/v1/webhooks/enrichlayer/email?nonce=${nonce}`,
        }),
        { apiKey: PLATFORM_KEY },
      );
    });
  });
});
