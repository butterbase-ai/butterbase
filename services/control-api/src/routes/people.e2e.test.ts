// services/control-api/src/routes/people.e2e.test.ts
//
// End-to-end smoke test for People routes.
// Requires a real Postgres database — set TEST_DATABASE_URL to opt in.
// Mirror of the env-var-gating pattern used in gateway.v2.e2e.test.ts.
//
// Harness:
//   - Real pg.Pool for people_email_lookups rows
//   - Full Fastify boot (peopleRoutes + peopleWebhookRoutes)
//   - Stub adapter via setPeopleAdapter()
//   - Routing/Redis mocked (region-resolver, runtime-pool-registry, redis)
//   - Pricing driven by env vars: PEOPLE_BASE_USD_PER_CREDIT=0.0168, PEOPLE_MARKUP_PCT=20
//
// Run: TEST_DATABASE_URL=<postgres-url> pnpm --filter @butterbase/control-api test people.e2e

// Set pricing env vars before any module import (pricing.ts reads process.env at call time
// so setting them here is sufficient; these are not module-init-time reads).
process.env.PEOPLE_BASE_USD_PER_CREDIT = '0.0168';
process.env.PEOPLE_MARKUP_PCT = '20';

// ── Gate: skip if no test DB configured (mirror gateway.v2.e2e.test.ts) ─────
const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = !!DB_URL;

// ── Module mocks (hoisted by Vitest before imports) ───────────────────────────

import { vi } from 'vitest';

vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(),
}));

vi.mock('../services/runtime-pool-registry.js', () => ({
  listRuntimeRegions: vi.fn(() => ['local']),
  runtimePoolFor: vi.fn(),
}));

// Redis is used fire-and-forget inside incrementUsage — no-op it.
vi.mock('../services/redis.js', () => ({
  getRedisClient: () => ({
    get: async () => null,
    setex: async () => 'OK',
    del: async () => 0,
    incrby: async () => 1,
    expire: async () => 1,
  }),
}));

vi.mock('../config.js', () => ({
  config: {
    people: {
      enabled: true,
      minBalanceUsd: 0.01,
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
          webhookHostUrl: 'https://test.local',
        },
        secondary: {
          apiKey: '',
          baseUrl: '',
          creditCostHeader: '',
          authScheme: 'bearer',
          baseUsdPerCredit: 0,
          markupPct: 0,
          fallbackCreditsPerAction: 1,
          webhookHostUrl: '',
        },
      },
    },
    auth: { enabled: false },
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import { peopleRoutes } from './people.js';
import { peopleWebhookRoutes } from './people-webhook.js';
import { registerPeopleAdapter, unregisterPeopleAdapter } from '../services/people/registry.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { listRuntimeRegions, runtimePoolFor } from '../services/runtime-pool-registry.js';
import type { PeopleAdapter, ProfilePayload } from '../services/people/types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** 0.0168 × 1.20 = 0.02016 */
const USD_PER_CREDIT = 0.0168 * 1.20;

const SAMPLE_PROFILE: ProfilePayload = {
  publicIdentifier: 'test-person-a',
  firstName: 'Test',
  lastName: 'Person',
  fullName: 'Test Person',
  headline: 'CTO',
  occupation: null,
  summary: null,
  city: 'San Francisco',
  state: 'CA',
  country: 'US',
  experiences: [],
  education: [],
  raw: {},
};

// ── DDL helpers ───────────────────────────────────────────────────────────────
//
// Create tables IF NOT EXISTS with minimal schema compatible with the route code.
// We omit FK constraints across control/runtime boundary — in production these
// live in separate databases so no cross-DB FK exists anyway.

const DDL = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS platform_users (
  id                    UUID PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE,
  password_hash         TEXT NOT NULL DEFAULT '',
  credits_usd           NUMERIC(10,4) NOT NULL DEFAULT 0,
  monthly_allowance_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS monthly_allowance_usd NUMERIC(10,4) NOT NULL DEFAULT 0;
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS credits_usd NUMERIC(10,4) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS apps (
  id                               TEXT PRIMARY KEY,
  name                             TEXT NOT NULL DEFAULT 'test-app',
  owner_id                         UUID NOT NULL,
  db_name                          TEXT NOT NULL DEFAULT '',
  db_provisioned                   BOOLEAN NOT NULL DEFAULT false,
  region                           TEXT NOT NULL DEFAULT 'local',
  people_byok_key_encrypted   BYTEA,
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS people_byok_key_encrypted BYTEA;

CREATE TABLE IF NOT EXISTS people_profile_cache (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id         TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  status         TEXT NOT NULL,
  payload_jsonb  JSONB,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  UNIQUE (app_id, normalized_url)
);

CREATE TABLE IF NOT EXISTS people_email_lookups (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           TEXT NOT NULL,
  user_id          UUID NOT NULL,
  normalized_url   TEXT NOT NULL,
  nonce            TEXT NOT NULL UNIQUE,
  key_type         TEXT NOT NULL DEFAULT 'platform',
  status           TEXT NOT NULL DEFAULT 'pending',
  email            TEXT,
  credits_consumed INTEGER NOT NULL DEFAULT 0,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS people_usage_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           TEXT NOT NULL,
  user_id          UUID NOT NULL,
  action           TEXT NOT NULL,
  credits_consumed INTEGER NOT NULL DEFAULT 0,
  usd_cost         NUMERIC(10,6) NOT NULL DEFAULT 0,
  usd_charged      NUMERIC(10,6) NOT NULL DEFAULT 0,
  key_type         TEXT NOT NULL DEFAULT 'platform',
  request_id       TEXT,
  response_status  INTEGER,
  linkedin_url     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// ── Test suite ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)('people e2e smoke', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;

  // Test-scoped identifiers: randomised so each run is isolated.
  const userId = randomUUID();
  const appId = randomUUID(); // UUID stored as text in apps.id

  // Shared adapter stub — defined at describe scope so the it() block can
  // inspect call counts after each step.
  let adapter: PeopleAdapter;

  // ── Setup ───────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    // Connect to the test database.
    pool = new pg.Pool({ connectionString: DB_URL!, max: 5 });

    // Provision required tables (idempotent — IF NOT EXISTS).
    await pool.query(DDL);

    // Seed test user with $1.00 top-up credit and $0 monthly allowance.
    await pool.query(
      `INSERT INTO platform_users (id, email, password_hash, credits_usd, monthly_allowance_usd)
       VALUES ($1, $2, '', 1.00, 0.00)
       ON CONFLICT (id) DO UPDATE
         SET credits_usd = 1.00, monthly_allowance_usd = 0.00`,
      [userId, `e2e-${userId}@test.local`],
    );

    // Seed test app owned by the test user (no BYOK key → uses platform key).
    await pool.query(
      `INSERT INTO apps (id, owner_id) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [appId, userId],
    );

    // Wire the test pool into the mocked routing layer.
    vi.mocked(getRuntimeDbForApp).mockResolvedValue(pool as any);
    vi.mocked(runtimePoolFor).mockReturnValue(pool as any);
    vi.mocked(listRuntimeRegions).mockReturnValue(['local']);

    // Build the stub adapter.
    adapter = {
      searchPerson: vi.fn().mockResolvedValue({
        data: {
          results: [{ publicIdentifier: 'a', linkedinUrl: 'https://www.linkedin.com/in/a' }],
          totalResultCount: 2,
          nextPage: null,
        },
        creditsConsumed: 6,
        requestId: 'req-search-1',
        status: 200,
      }),
      searchCompany: vi.fn().mockResolvedValue({
        data: { results: [], totalResultCount: 0, nextPage: null },
        creditsConsumed: 0,
        requestId: null,
        status: 200,
      }),
      getProfile: vi.fn().mockResolvedValue({
        data: SAMPLE_PROFILE,
        creditsConsumed: 2,
        requestId: 'req-profile-1',
        status: 200,
        notFound: false,
      }),
      queueEmailLookup: vi.fn().mockResolvedValue({
        data: { queued: true },
        creditsConsumed: 0,
        requestId: 'req-email-1',
        status: 200,
      }),
    };
    registerPeopleAdapter('primary', adapter);

    // Boot Fastify with real pool + both route modules.
    app = Fastify({ logger: false });

    // Stub auth: inject a fixed userId for every request.
    app.decorateRequest('auth', null as any);
    app.addHook('onRequest', async (request) => {
      (request as any).auth = {
        userId,
        authMethod: 'api_key' as const,
        scopes: ['*'],
      };
    });

    // Decorate with the real pool (deductCreditsBalance/getCreditsBalance use this).
    app.decorate('controlDb', pool as any);

    await app.register(peopleRoutes);
    await app.register(peopleWebhookRoutes);
    await app.ready();
  }, 30_000);

  // ── Teardown ─────────────────────────────────────────────────────────────────

  afterAll(async () => {
    unregisterPeopleAdapter('primary');
    await app?.close();

    // Delete test rows (leave tables intact for subsequent runs).
    if (pool) {
      await pool.query(
        `DELETE FROM people_email_lookups WHERE app_id = $1`, [appId],
      );
      await pool.query(
        `DELETE FROM people_profile_cache WHERE app_id = $1`, [appId],
      );
      await pool.query(
        `DELETE FROM people_usage_logs WHERE app_id = $1`, [appId],
      );
      await pool.query(`DELETE FROM apps WHERE id = $1`, [appId]);
      await pool.query(`DELETE FROM platform_users WHERE id = $1`, [userId]);
      await pool.end();
    }
  }, 30_000);

  // ── Single flow test ─────────────────────────────────────────────────────────
  //
  // Steps run sequentially in one it() so balance state flows through.

  it('search → profile (cache-miss + hit) → email queue → webhook → idempotent retry', async () => {
    // ── Step 1: POST /search/person — 6 credits charged ───────────────────────
    //   usdCharged ≈ 6 × 0.02016 = 0.12096
    //   balance after ≈ 1.00 − 0.12096 = 0.87904

    const r1 = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/people/search/person`,
      payload: { currentRoleTitle: 'CTO' },
    });

    expect(r1.statusCode).toBe(200);
    const b1 = r1.json<{ usage: { creditsConsumed: number; usdCharged: number } }>();
    expect(b1.usage.creditsConsumed).toBe(6);
    expect(b1.usage.usdCharged).toBeCloseTo(6 * USD_PER_CREDIT, 5);

    const bal1 = await pool.query<{ credits_usd: string }>(
      `SELECT credits_usd FROM platform_users WHERE id = $1`, [userId],
    );
    expect(parseFloat(bal1.rows[0].credits_usd)).toBeCloseTo(1.00 - 6 * USD_PER_CREDIT, 5);

    // ── Step 2: POST /profile (cache miss → adapter called, 2 credits) ─────────
    //   usdCharged ≈ 2 × 0.02016 = 0.04032
    //   balance after ≈ 0.87904 − 0.04032 = 0.83872

    const r2 = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/people/profile`,
      payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/a' },
    });

    expect(r2.statusCode).toBe(200);
    const b2 = r2.json<{ status: string; usage: { cached: boolean; usdCharged: number } }>();
    expect(b2.usage.cached).toBe(false);
    expect(b2.status).toBe('ok');
    expect(b2.usage.usdCharged).toBeCloseTo(2 * USD_PER_CREDIT, 5);

    const bal2 = await pool.query<{ credits_usd: string }>(
      `SELECT credits_usd FROM platform_users WHERE id = $1`, [userId],
    );
    expect(parseFloat(bal2.rows[0].credits_usd)).toBeCloseTo(1.00 - 8 * USD_PER_CREDIT, 5);

    // ── Step 3: POST /profile again (same URL → cache hit, $0) ───────────────
    //   response.usage.cached === true
    //   usdCharged === 0
    //   balance unchanged (≈ 0.83872)
    //   adapter.getProfile called exactly once total

    const r3 = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/people/profile`,
      payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/a' },
    });

    expect(r3.statusCode).toBe(200);
    const b3 = r3.json<{ usage: { cached: boolean; usdCharged: number } }>();
    expect(b3.usage.cached).toBe(true);
    expect(b3.usage.usdCharged).toBe(0);

    const bal3 = await pool.query<{ credits_usd: string }>(
      `SELECT credits_usd FROM platform_users WHERE id = $1`, [userId],
    );
    expect(parseFloat(bal3.rows[0].credits_usd)).toBeCloseTo(1.00 - 8 * USD_PER_CREDIT, 5);

    // Adapter must have been called exactly once (cache served the second call).
    expect(adapter.getProfile).toHaveBeenCalledTimes(1);

    // ── Step 4: POST /profile/email → pending row ────────────────────────────
    //   response.lookupId is a UUID, response.status === 'pending'
    //   DB: one row in people_email_lookups with status='pending' and 64-char hex nonce

    const r4 = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/people/profile/email`,
      payload: { linkedinProfileUrl: 'https://www.linkedin.com/in/a' },
    });

    expect(r4.statusCode).toBe(200);
    const b4 = r4.json<{ lookupId: string; status: string }>();
    expect(b4.lookupId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(b4.status).toBe('pending');

    const dbLookup = await pool.query<{ status: string; nonce: string }>(
      `SELECT status, nonce FROM people_email_lookups WHERE id = $1`,
      [b4.lookupId],
    );
    expect(dbLookup.rows).toHaveLength(1);
    expect(dbLookup.rows[0].status).toBe('pending');
    expect(dbLookup.rows[0].nonce).toMatch(/^[0-9a-f]{64}$/);

    const nonce = dbLookup.rows[0].nonce;

    // ── Step 5: POST /webhooks/people/email — first delivery ────────────
    //   response 200 { ok: true }
    //   DB: lookup row status='resolved', email='x@y.com'
    //   balance after ≈ 0.83872 − 0.02016 = 0.81856

    const r5 = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/people/email?nonce=${nonce}`,
      headers: { 'x-cost': '1' },
      payload: { email: 'x@y.com' },
    });

    expect(r5.statusCode).toBe(200);
    expect(r5.json()).toEqual({ ok: true });

    const dbResolved = await pool.query<{ status: string; email: string }>(
      `SELECT status, email FROM people_email_lookups WHERE id = $1`,
      [b4.lookupId],
    );
    expect(dbResolved.rows[0].status).toBe('resolved');
    expect(dbResolved.rows[0].email).toBe('x@y.com');

    const bal5 = await pool.query<{ credits_usd: string }>(
      `SELECT credits_usd FROM platform_users WHERE id = $1`, [userId],
    );
    expect(parseFloat(bal5.rows[0].credits_usd)).toBeCloseTo(1.00 - 9 * USD_PER_CREDIT, 5);

    // ── Step 6: POST same webhook again — idempotent retry ───────────────────
    //   response 200 { ignored: true }
    //   balance UNCHANGED — no double-charge

    const r6 = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/people/email?nonce=${nonce}`,
      headers: { 'x-cost': '1' },
      payload: { email: 'x@y.com' },
    });

    expect(r6.statusCode).toBe(200);
    expect(r6.json()).toEqual({ ignored: true });

    const bal6 = await pool.query<{ credits_usd: string }>(
      `SELECT credits_usd FROM platform_users WHERE id = $1`, [userId],
    );
    expect(parseFloat(bal6.rows[0].credits_usd)).toBeCloseTo(1.00 - 9 * USD_PER_CREDIT, 5);
  }, 30_000);
});
