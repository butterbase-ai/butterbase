// services/control-api/src/routes/people.test.ts
// Unit tests for People routes. All external dependencies are mocked —
// no real database or network connections required.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// ── Module mocks (vi.mock is hoisted by vitest before imports) ───────────────

vi.mock('../services/people/registry.js', () => ({
  getPeopleAdapter: vi.fn(),
}));

vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(),
}));

vi.mock('../services/people/cache.js', () => ({
  lookupCachedProfile: vi.fn(),
  writeCachedProfile: vi.fn(),
}));

vi.mock('../services/usage-metering.js', () => ({
  getCreditsBalance: vi.fn(),
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
      minBalanceUsd: 0.05,
      routing: {},
      providers: {
        primary: {
          apiKey: 'platform-key',
          baseUrl: '',
          creditCostHeader: 'x-cost',
          authScheme: 'bearer',
          baseUsdPerCredit: 0.0168,
          markupPct: 20,
          fallbackCreditsPerAction: 1,
          webhookHostUrl: 'https://api.butterbase.ai',
        },
        secondary: {
          apiKey: '',
          baseUrl: '',
          creditCostHeader: 'x-secondary-credit-cost',
          authScheme: 'bearer',
          baseUsdPerCredit: 0.0168,
          markupPct: 20,
          fallbackCreditsPerAction: 1,
          webhookHostUrl: '',
        },
      },
    },
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { peopleRoutes } from './people.js';
import { getPeopleAdapter } from '../services/people/registry.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { lookupCachedProfile, writeCachedProfile } from '../services/people/cache.js';
import { getCreditsBalance, deductCreditsBalance, incrementUsage } from '../services/usage-metering.js';
import { getPeoplePricing } from '../services/people/pricing.js';
import { config } from '../config.js';
import { PeopleError, PeopleProviderError } from '../services/people/types.js';
import type { PeopleAdapter, ProfilePayload } from '../services/people/types.js';

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

/**
 * Make a minimal mock runtime pg.Pool whose query() is a vi.fn().
 * @param ownerId - owner_id to return for assertAppOwnership; null = app not found (empty rows)
 */
function makeMockRuntime(ownerId: string | null = USER_ID) {
  const runtimeQuery = vi.fn().mockImplementation((sql: string, _params: unknown[]) => {
    // Ownership check: SELECT owner_id FROM apps WHERE id = $1
    if (typeof sql === 'string' && sql.includes('owner_id') && sql.includes('FROM apps')) {
      if (ownerId === null) {
        return Promise.resolve({ rows: [], rowCount: 0 }); // app not found
      }
      return Promise.resolve({ rows: [{ owner_id: ownerId }], rowCount: 1 });
    }
    if (typeof sql === 'string' && sql.includes('people_email_lookups') && sql.includes('INSERT')) {
      return Promise.resolve({ rows: [{ id: 'lookup-abc' }], rowCount: 1 });
    }
    if (typeof sql === 'string' && sql.includes('people_email_lookups') && sql.includes('SELECT')) {
      return Promise.resolve({
        rows: [{ status: 'pending', email: null, credits_consumed: 0, provider_slot: 'primary' }],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return { query: runtimeQuery } as any;
}

/** Make a minimal mock adapter whose methods are vi.fn() */
function makeMockAdapter(overrides: Partial<PeopleAdapter> = {}): PeopleAdapter {
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
    ...overrides,
  };
}

/** Build a test Fastify app with auth stubbed and controlDb mocked */
async function buildTestApp(userId = USER_ID): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('auth', null as any);
  app.addHook('onRequest', async (request) => {
    (request as any).auth = { userId, authMethod: 'api_key', scopes: ['*'] };
  });
  // Provide a controlDb decoration so usage-metering mocks can receive it
  app.decorate('controlDb', {} as any);
  await app.register(peopleRoutes);
  await app.ready();
  return app;
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('People routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── Scenario 1: search/person platform key → metering + audit + deduct ────
  describe('POST /v1/:appId/people/search/person — platform key', () => {
    it('calls adapter, deducts credits, increments usage, writes audit row, sets x-people-* headers', async () => {
      const mockRuntime = makeMockRuntime(); // owner = USER_ID
      const mockAdapter = makeMockAdapter(); // creditsConsumed=6
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 1.0, totalUsd: 1.0 });
      vi.mocked(deductCreditsBalance).mockResolvedValue(6 * USD_PER_CREDIT);
      vi.mocked(incrementUsage).mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/people/search/person`,
        payload: { currentRoleTitle: 'CTO' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.usage.creditsConsumed).toBe(6);

      // x-people-* response headers
      expect(res.headers['x-people-provider']).toBe('primary');
      expect(res.headers['x-people-credits-consumed']).toBe('6');
      expect(parseFloat(res.headers['x-people-usd-charged'] as string)).toBeCloseTo(6 * USD_PER_CREDIT, 4);

      // Metering
      expect(deductCreditsBalance).toHaveBeenCalledWith(
        expect.anything(),
        USER_ID,
        6 * USD_PER_CREDIT,
      );
      expect(incrementUsage).toHaveBeenCalledWith(USER_ID, 'people_credits', 6, APP_ID);

      // Audit row
      const auditCall = mockRuntime.query.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('people_usage_logs'),
      );
      expect(auditCall).toBeDefined();
      expect(auditCall![1]).toContain('search_person');
      expect(auditCall![1]).toContain('primary'); // provider_slot
    });
  });

  // ── Scenario 2: profile cache hit → adapter NOT called ────────────────────
  describe('POST /v1/:appId/people/profile — cache hit', () => {
    it('serves from cache, adapter not called, audit action=profile_cache_hit, no charge, x-people-cached=true', async () => {
      const mockRuntime = makeMockRuntime();
      const mockAdapter = makeMockAdapter();
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(lookupCachedProfile).mockResolvedValue({ status: 'ok', payload: SAMPLE_PROFILE });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/people/profile`,
        payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/jane-doe' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.usage.cached).toBe(true);
      expect(body.usage.creditsConsumed).toBe(0);

      // x-people-* headers on cache hit
      expect(res.headers['x-people-provider']).toBe('primary');
      expect(res.headers['x-people-credits-consumed']).toBe('0');
      expect(res.headers['x-people-cached']).toBe('true');

      // Adapter NOT called
      expect(mockAdapter.getProfile).not.toHaveBeenCalled();

      // No charge
      expect(deductCreditsBalance).not.toHaveBeenCalled();
      expect(incrementUsage).not.toHaveBeenCalled();

      // Audit row: action='profile_cache_hit'
      const auditCall = mockRuntime.query.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('people_usage_logs'),
      );
      expect(auditCall).toBeDefined();
      expect(auditCall![1]).toContain('profile_cache_hit');
      expect(auditCall![1]).toContain(0); // credits_consumed = 0
    });
  });

  // ── Scenario 3: profile cache miss + ok → adapter called, cache written ───
  describe('POST /v1/:appId/people/profile — cache miss ok', () => {
    it('calls adapter, writes ok cache (with slot), charges user, sets x-people-cached=false', async () => {
      const mockRuntime = makeMockRuntime();
      const mockAdapter = makeMockAdapter({
        getProfile: vi.fn().mockResolvedValue({
          data: SAMPLE_PROFILE,
          creditsConsumed: 5,
          requestId: 'req-3',
          status: 200,
          notFound: false,
        }),
      });
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(lookupCachedProfile).mockResolvedValue(null); // cache miss
      vi.mocked(writeCachedProfile).mockResolvedValue(undefined);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 1.0, totalUsd: 1.0 });
      vi.mocked(deductCreditsBalance).mockResolvedValue(5 * USD_PER_CREDIT);
      vi.mocked(incrementUsage).mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/people/profile`,
        payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/jane-doe' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('ok');
      expect(body.usage.cached).toBe(false);

      // x-people-* headers
      expect(res.headers['x-people-provider']).toBe('primary');
      expect(res.headers['x-people-cached']).toBe('false');

      // Cache written with status='ok' and slot='primary'
      expect(writeCachedProfile).toHaveBeenCalledWith(
        mockRuntime,
        APP_ID,
        'https://www.linkedin.com/in/jane-doe',
        'ok',
        SAMPLE_PROFILE,
        'primary',
      );

      // Charged
      expect(deductCreditsBalance).toHaveBeenCalledWith(expect.anything(), USER_ID, 5 * USD_PER_CREDIT);
      expect(incrementUsage).toHaveBeenCalledWith(USER_ID, 'people_credits', 5, APP_ID);
    });
  });

  // ── Scenario 4: profile cache miss + not_found → cache written, $0 charge ─
  describe('POST /v1/:appId/people/profile — cache miss not_found', () => {
    it('writes not_found cache (with slot), no charge', async () => {
      const mockRuntime = makeMockRuntime();
      const mockAdapter = makeMockAdapter({
        getProfile: vi.fn().mockResolvedValue({
          data: null,
          creditsConsumed: 0,
          requestId: 'req-3',
          status: 404,
          notFound: true,
        }),
      });
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(lookupCachedProfile).mockResolvedValue(null);
      vi.mocked(writeCachedProfile).mockResolvedValue(undefined);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 1.0, totalUsd: 1.0 });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/people/profile`,
        payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/jane-doe' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('not_found');

      // Cache written with status='not_found' and slot='primary' (7d TTL is in writeCachedProfile)
      expect(writeCachedProfile).toHaveBeenCalledWith(
        mockRuntime,
        APP_ID,
        'https://www.linkedin.com/in/jane-doe',
        'not_found',
        null,
        'primary',
      );

      // No charge when creditsConsumed=0
      expect(deductCreditsBalance).not.toHaveBeenCalled();
      expect(incrementUsage).not.toHaveBeenCalled();
    });
  });

  // ── Scenario 5: insufficient balance → 402, adapter not called ────────────
  describe('POST /v1/:appId/people/search/person — low balance', () => {
    it('returns 402 and does not call the adapter', async () => {
      const mockRuntime = makeMockRuntime();
      const mockAdapter = makeMockAdapter();
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 0.01, totalUsd: 0.01 });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/people/search/person`,
        payload: { currentRoleTitle: 'CEO' },
      });

      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ error: 'insufficient_credits' });

      // x-people-* headers present on 402 (all zero for non-success paths)
      expect(res.headers['x-people-provider']).toBe('primary');
      expect(res.headers['x-people-credits-consumed']).toBe('0');
      expect(res.headers['x-people-usd-charged']).toBe('0.000000');

      // Adapter NOT called
      expect(mockAdapter.searchPerson).not.toHaveBeenCalled();
    });
  });

  // ── Scenario 6: profile/email → pending row, nonce in callbackUrl ─────────
  describe('POST /v1/:appId/people/profile/email', () => {
    it('inserts pending row with key_type=platform + provider_slot, calls adapter with nonce in callbackUrl, returns lookupId', async () => {
      const mockRuntime = makeMockRuntime();
      const mockAdapter = makeMockAdapter();
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 1.0, totalUsd: 1.0 });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/people/profile/email`,
        payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/jane-doe' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.lookupId).toBe('lookup-abc');
      expect(body.status).toBe('pending');

      // x-people-* headers
      expect(res.headers['x-people-provider']).toBe('primary');

      // Verify the INSERT into people_email_lookups happened before adapter call
      const insertCall = mockRuntime.query.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('people_email_lookups') && (c[0] as string).includes('INSERT'),
      );
      expect(insertCall).toBeDefined();

      // The nonce in the INSERT params matches the nonce in the callbackUrl passed to adapter
      const insertParams = insertCall![1] as string[];
      const nonce = insertParams[3]; // [appId, userId, normalizedUrl, nonce, key_type, slot]
      expect(nonce).toMatch(/^[0-9a-f]{64}$/); // 32 bytes = 64 hex chars

      // Platform key → key_type='platform' stored in lookup row
      expect(insertParams[4]).toBe('platform');
      // provider_slot also stored
      expect(insertParams[5]).toBe('primary');

      expect(mockAdapter.queueEmailLookup).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackUrl: `https://api.butterbase.ai/v1/webhooks/people/email?nonce=${nonce}`,
        }),
        { apiKey: PLATFORM_KEY },
      );
    });
  });

  // ── Scenario 7: IDOR — ownership 403 ─────────────────────────────────────
  describe('IDOR / ownership checks', () => {
    it('POST search/person returns 403 when authed user does not own the app', async () => {
      const attackerApp = await buildTestApp('u_attacker');
      const mockRuntime = makeMockRuntime('u_owner'); // app owned by u_owner, not u_attacker
      const mockAdapter = makeMockAdapter();
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);

      try {
        const res = await attackerApp.inject({
          method: 'POST',
          url: `/v1/${APP_ID}/people/search/person`,
          payload: { currentRoleTitle: 'CTO' },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ error: 'forbidden' });
        expect(mockAdapter.searchPerson).not.toHaveBeenCalled();
      } finally {
        await attackerApp.close();
      }
    });

    it('POST search/person returns 404 when app does not exist', async () => {
      const mockRuntime = makeMockRuntime(null); // no row → app_not_found
      const mockAdapter = makeMockAdapter();
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/people/search/person`,
        payload: { currentRoleTitle: 'CTO' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'app_not_found' });
      expect(mockAdapter.searchPerson).not.toHaveBeenCalled();
    });
  });

  // ── Scenario 8: profile/email 503 on empty webhookHostUrl ───────────────
  describe('POST /v1/:appId/people/profile/email — webhookHostUrl guard', () => {
    it('returns 503 people_unavailable before INSERT when webhookHostUrl is empty', async () => {
      const mockRuntime = makeMockRuntime();
      const mockAdapter = makeMockAdapter();
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);

      const originalUrl = config.people.providers.primary.webhookHostUrl;
      (config.people.providers.primary as any).webhookHostUrl = '';

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/people/profile/email`,
        payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/jane-doe' },
      });

      (config.people.providers.primary as any).webhookHostUrl = originalUrl;

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'people_unavailable' });

      // x-people-* headers present on 503 (all zero for non-success paths)
      expect(res.headers['x-people-provider']).toBe('primary');
      expect(res.headers['x-people-credits-consumed']).toBe('0');
      expect(res.headers['x-people-usd-charged']).toBe('0.000000');

      // No INSERT into people_email_lookups
      const insertCall = mockRuntime.query.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string'
          && (c[0] as string).includes('people_email_lookups')
          && (c[0] as string).includes('INSERT'),
      );
      expect(insertCall).toBeUndefined();
      expect(mockAdapter.queueEmailLookup).not.toHaveBeenCalled();
    });
  });

  // ── Scenario 9: feature flag disabled → 503 people_disabled ─────────
  describe('feature flag disabled', () => {
    it('all people routes return 503 people_disabled when enabled=false', async () => {
      const mockRuntime = makeMockRuntime();
      const mockAdapter = makeMockAdapter();
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);

      const originalEnabled = config.people.enabled;
      (config.people as any).enabled = false;

      try {
        const routes = [
          { method: 'POST' as const, url: `/v1/${APP_ID}/people/search/person`, payload: { currentRoleTitle: 'CTO' } },
          { method: 'POST' as const, url: `/v1/${APP_ID}/people/search/company`, payload: { industry: 'tech' } },
          { method: 'POST' as const, url: `/v1/${APP_ID}/people/profile`, payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/jane-doe' } },
          { method: 'POST' as const, url: `/v1/${APP_ID}/people/profile/email`, payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/jane-doe' } },
          { method: 'GET' as const, url: `/v1/${APP_ID}/people/email-lookup/some-id` },
        ];

        for (const route of routes) {
          const res = await app.inject(route as any);
          expect(res.statusCode, `${route.method} ${route.url}`).toBe(503);
          expect(res.json(), `${route.method} ${route.url}`).toMatchObject({ error: 'people_disabled' });
        }

        // Adapter never called when feature is disabled
        expect(mockAdapter.searchPerson).not.toHaveBeenCalled();
        expect(mockAdapter.searchCompany).not.toHaveBeenCalled();
        expect(mockAdapter.getProfile).not.toHaveBeenCalled();
        expect(mockAdapter.queueEmailLookup).not.toHaveBeenCalled();
      } finally {
        (config.people as any).enabled = originalEnabled;
      }
    });
  });

  // ── Scenario 10: failure-path audit row ───────────────────────────────────
  describe('search_person adapter throw → audit row written with search_person_error', () => {
    it('writes an audit row with action=search_person_error and zero financials on adapter throw', async () => {
      const mockRuntime = makeMockRuntime();
      const mockAdapter = makeMockAdapter({
        searchPerson: vi.fn().mockRejectedValue(
          new PeopleError(502, 'upstream_error', 'upstream error'),
        ),
      });
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 1.0, totalUsd: 1.0 });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/people/search/person`,
        payload: { currentRoleTitle: 'CTO' },
      });

      expect(res.statusCode).toBe(502);

      // x-people-* headers present on error paths (all zero)
      expect(res.headers['x-people-provider']).toBe('primary');
      expect(res.headers['x-people-credits-consumed']).toBe('0');
      expect(res.headers['x-people-usd-charged']).toBe('0.000000');

      // Audit row written with action='search_person_error', zero financials
      const auditCall = mockRuntime.query.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('people_usage_logs'),
      );
      expect(auditCall).toBeDefined();
      const auditParams = auditCall![1] as unknown[];
      expect(auditParams).toContain('search_person_error');
      expect(auditParams).toContain(0); // creditsConsumed = 0
      expect(auditParams).toContain(502); // responseStatus from PeopleError
    });
  });

  // ── Scenario 11: profile/email adapter throw → orphan row cleaned up ──────
  describe('profile/email adapter throw → orphan pending row deleted', () => {
    it('DELETEs the pending people_email_lookups row on adapter throw', async () => {
      const mockRuntime = makeMockRuntime();
      const mockAdapter = makeMockAdapter({
        queueEmailLookup: vi.fn().mockRejectedValue(
          new PeopleError(502, 'adapter_error', 'adapter failure'),
        ),
      });
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 1.0, totalUsd: 1.0 });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/people/profile/email`,
        payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/jane-doe' },
      });

      expect(res.statusCode).toBe(502);

      // DELETE was called for the orphan pending row
      const deleteCall = mockRuntime.query.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string'
          && (c[0] as string).includes('DELETE FROM people_email_lookups'),
      );
      expect(deleteCall).toBeDefined();
      const deleteParams = deleteCall![1] as unknown[];
      expect(deleteParams[0]).toBe('lookup-abc'); // the id returned by the INSERT mock
      expect(deleteParams[1]).toBe('pending');

      // Audit row for error written
      const auditCall = mockRuntime.query.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('people_usage_logs'),
      );
      expect(auditCall).toBeDefined();
      expect(auditCall![1]).toContain('profile_email_error');
    });
  });

  // ── Scenario 12: PeopleProviderError action_unsupported_by_slot → 503 ─────
  describe('PeopleProviderError action_unsupported_by_slot → 503 provider_action_unsupported', () => {
    it('returns 503 { error: provider_action_unsupported, slot } when adapter throws PeopleProviderError', async () => {
      const mockRuntime = makeMockRuntime();
      const mockAdapter = makeMockAdapter({
        searchPerson: vi.fn().mockRejectedValue(
          new PeopleProviderError('action_unsupported_by_slot', 'search_person is not supported on the secondary slot'),
        ),
      });
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 1.0, totalUsd: 1.0 });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/people/search/person`,
        payload: { currentRoleTitle: 'CTO' },
      });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error).toBe('provider_action_unsupported');
      expect(body.slot).toBe('primary'); // resolved slot from config.people.routing (empty → primary)

      // x-people-* headers present on 503 (all zero for non-success paths)
      expect(res.headers['x-people-provider']).toBe('primary');
      expect(res.headers['x-people-credits-consumed']).toBe('0');
      expect(res.headers['x-people-usd-charged']).toBe('0.000000');

      // Adapter was called (the error came FROM the adapter)
      expect(mockAdapter.searchPerson).toHaveBeenCalledOnce();
    });
  });

  // ── Scenario 13: getPeopleAdapter returns null → 503 provider_not_registered ─
  describe('POST /v1/:appId/people/search/person — no adapter registered', () => {
    it('returns 503 { error: provider_not_registered, slot } with all x-people-* headers at zero', async () => {
      const mockRuntime = makeMockRuntime();
      vi.mocked(getPeopleAdapter).mockReturnValue(null as any);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 1.0, totalUsd: 1.0 });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/people/search/person`,
        payload: { currentRoleTitle: 'CEO' },
      });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error).toBe('provider_not_registered');
      expect(body.slot).toBe('primary');

      // All x-people-* headers present with zero values
      expect(res.headers['x-people-provider']).toBe('primary');
      expect(res.headers['x-people-credits-consumed']).toBe('0');
      expect(res.headers['x-people-usd-charged']).toBe('0.000000');
    });
  });

  // ── Scenario 14: usdPerCredit=0 (free provider) skips balance gate ────────
  describe('POST /v1/:appId/people/search/person — free provider (usdPerCredit=0)', () => {
    it('skips balance gate and deductCreditsBalance when usdPerCredit=0', async () => {
      const mockRuntime = makeMockRuntime();
      const mockAdapter = makeMockAdapter(); // creditsConsumed=6
      vi.mocked(getPeopleAdapter).mockReturnValue(mockAdapter);
      vi.mocked(getRuntimeDbForApp).mockResolvedValue(mockRuntime);
      // Override pricing to usdPerCredit=0 for this test only
      vi.mocked(getPeoplePricing).mockReturnValueOnce({
        baseUsdPerCredit: 0,
        markupPct: 0,
        usdPerCredit: 0,
      });
      // Balance is below the normal minBalanceUsd threshold — but gate is skipped because usdPerCredit=0
      vi.mocked(getCreditsBalance).mockResolvedValue({ monthlyAllowanceUsd: 0, topupUsd: 0.01, totalUsd: 0.01 });
      vi.mocked(incrementUsage).mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/${APP_ID}/people/search/person`,
        payload: { currentRoleTitle: 'CEO' },
      });

      // Balance gate was skipped: usdPerCredit=0, so 200 despite low balance
      expect(res.statusCode).toBe(200);

      // Adapter WAS called
      expect(mockAdapter.searchPerson).toHaveBeenCalledOnce();

      // usdCost = creditsConsumed × 0 = 0 → deductCreditsBalance NOT called
      expect(deductCreditsBalance).not.toHaveBeenCalled();
    });
  });
});
