/**
 * hackathons-scoring-db.test.ts
 *
 * Integration tests for the scoreSubmission service that require BOTH:
 *   - controlDb  : hackathon tables (hackathons, hackathon_submissions, hackathon_scores, …)
 *   - runtimeDb  : feature tables (apps, app_functions, app_users, storage_objects, …)
 *
 * These tests are skipped in default CI. Set RUN_DB_TESTS=1 to run them.
 * You also need RUNTIME_DB_URL pointing at a local runtime DB that has the
 * feature tables (apps, app_functions, app_users, storage_objects, app_db_connections).
 *
 * Background: migration 061 dropped runtime tables from the control-plane DB.
 * scoreSubmission(controlDb, …) resolves feature counts via getRuntimeDbForApp,
 * which returns a pool to the per-region runtime DB. In tests we mock
 * getRuntimeDbForApp to return the runtimeDb pool from test-helpers/control-db.ts.
 *
 * Cross-DB design note: scoreSubmission accepts a single `controlDb` pool.
 * Internally it calls getRuntimeDbForApp(controlDb, appId) to obtain the runtime
 * pool for feature queries, then writes hackathon_scores back to controlDb.
 * Tests therefore need to:
 *   1. Seed feature rows into runtimeDb (seeded here via seedApp/seedFeatures).
 *   2. Mock getRuntimeDbForApp to return runtimeDb.
 *   3. Seed hackathon rows into controlDb (via setupTestDb/seedUser/seedHackathon helpers).
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { setupTestDb, controlDb, runtimeDb, seedUser, seedHackathon, seedParticipant } from './test-helpers/control-db.js';
import { scoreSubmission } from '../services/hackathons/scoring.js';
import type { FieldSchema } from '../services/hackathons/field-schema.js';

// ── Gate: skip unless RUN_DB_TESTS=1 ────────────────────────────────────────
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

// ── Mock getRuntimeDbForApp to return runtimeDb ──────────────────────────────
// scoring.ts calls getRuntimeDbForApp(controlDb, appId) for feature table queries.
// We return the test runtimeDb pool so feature seeds are visible.
const mockGetRuntimeDbForApp = vi.fn();
vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: (...args: unknown[]) => mockGetRuntimeDbForApp(...args),
  AppNotFoundError: class AppNotFoundError extends Error {},
}));

// ── Test schemas ─────────────────────────────────────────────────────────────
const SCHEMA = {
  fields: [
    { key: 'project_name', type: 'text' as const, required: true, display: 'primary' as const, label: 'Project' },
    { key: 'demo_url', type: 'url' as const, required: true, display: 'primary' as const, label: 'Demo' },
  ],
} satisfies FieldSchema;

const SCHEMA_LIVE_URL = {
  fields: [
    { key: 'project_name', type: 'text' as const, required: true, display: 'primary' as const, label: 'Project' },
    { key: 'live_demo', type: 'url' as const, required: true, display: 'primary' as const, label: 'Live', is_url: true },
  ],
} satisfies FieldSchema;

const logger = { error: () => {} };

// ── Runtime DB helpers (feature tables) ──────────────────────────────────────
// These insert into runtimeDb (not controlDb) because apps/app_functions/etc.
// live on the per-region runtime DB post migration 061.

const TEST_APP_ID = 'app_scoring_test_001';

async function seedApp(appId: string, ownerId: string) {
  await runtimeDb.query(
    `INSERT INTO apps (id, name, db_name, owner_id, db_provisioned, region, provisioning_status)
     VALUES ($1, $2, $3, $4, false, 'us-east-1', 'ready')
     ON CONFLICT (id) DO NOTHING`,
    [appId, 'Test App', `db_${appId}`, ownerId],
  );
}

async function seedFeatures(appId: string) {
  await runtimeDb.query(
    `INSERT INTO app_db_connections (app_id, connection_string) VALUES ($1, 'postgresql://fake') ON CONFLICT DO NOTHING`,
    [appId],
  );
  // 3 functions (cap 5 → 3/5 = 0.6)
  for (let i = 0; i < 3; i++) {
    await runtimeDb.query(
      `INSERT INTO app_functions (id, app_id, name, code, trigger_type)
       VALUES (gen_random_uuid(), $1, $2, 'export default () => {}', 'http')`,
      [appId, `fn_${i}`],
    );
  }
  // 2 app_users (cap 5 → 2/5 = 0.4)
  for (let i = 0; i < 2; i++) {
    await runtimeDb.query(
      `INSERT INTO app_users (id, app_id, email) VALUES (gen_random_uuid(), $1, $2)`,
      [appId, `user${i}@test.com`],
    );
  }
  // 1 storage object (cap 10 → 1/10 = 0.1)
  await runtimeDb.query(
    `INSERT INTO storage_objects (id, app_id, bucket, key, size_bytes, content_type)
     VALUES (gen_random_uuid(), $1, 'default', 'file.txt', 100, 'text/plain')`,
    [appId],
  );
}

async function cleanupAppData(appId: string) {
  await runtimeDb.query('DELETE FROM storage_objects WHERE app_id = $1', [appId]);
  await runtimeDb.query('DELETE FROM app_users WHERE app_id = $1', [appId]);
  await runtimeDb.query('DELETE FROM app_functions WHERE app_id = $1', [appId]);
  await runtimeDb.query('DELETE FROM app_db_connections WHERE app_id = $1', [appId]);
  await runtimeDb.query('DELETE FROM apps WHERE id = $1', [appId]);
}

// ── Control DB submission helper ─────────────────────────────────────────────
async function createSubmission(userId: string, hackathonId: string, participantId: string, data: Record<string, unknown>, appId?: string | null) {
  const { rows } = await controlDb.query(
    `INSERT INTO hackathon_submissions (hackathon_id, participant_id, user_id, data, app_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (hackathon_id, participant_id) DO UPDATE
       SET data = EXCLUDED.data, app_id = EXCLUDED.app_id,
           version = hackathon_submissions.version + 1, updated_at = now()
     RETURNING id, version, data, app_id`,
    [hackathonId, participantId, userId, JSON.stringify(data), appId ?? null],
  );
  return rows[0];
}

// ── Tests ────────────────────────────────────────────────────────────────────
describeDb('scoreSubmission service', () => {
  beforeEach(async () => {
    await setupTestDb();
    await cleanupAppData(TEST_APP_ID);
    mockGetRuntimeDbForApp.mockReset();
    // Default: return runtimeDb for all appId lookups
    mockGetRuntimeDbForApp.mockImplementation(async () => runtimeDb);
  });

  it('scores 50 for demo_url ending in .butterbase.dev, 0 for features without app_id', async () => {
    const u = await seedUser('s1@x.com');
    const h = await seedHackathon({ slug: 'sc1', is_active: true, field_schema: SCHEMA });
    const p = await seedParticipant({ hackathon_id: h.id, user_id: u.id });
    const sub = await createSubmission(u.id, h.id, p.id, {
      project_name: 'Test',
      demo_url: 'https://myapp.butterbase.dev',
    });

    await scoreSubmission(controlDb, {
      id: sub.id, hackathon_id: h.id, participant_id: p.id, user_id: u.id,
      data: sub.data, app_id: null, field_schema: SCHEMA,
    }, logger);

    const { rows } = await controlDb.query('SELECT * FROM hackathon_scores WHERE submission_id = $1', [sub.id]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].criterion_demo_url)).toBe(50);
    expect(Number(rows[0].criterion_features)).toBe(0);
    expect(Number(rows[0].total_score)).toBe(50);
  });

  it('scores 0 for non-butterbase.dev demo_url', async () => {
    const u = await seedUser('s2@x.com');
    const h = await seedHackathon({ slug: 'sc2', is_active: true, field_schema: SCHEMA });
    const p = await seedParticipant({ hackathon_id: h.id, user_id: u.id });
    const sub = await createSubmission(u.id, h.id, p.id, {
      project_name: 'Test',
      demo_url: 'https://example.com',
    });

    await scoreSubmission(controlDb, {
      id: sub.id, hackathon_id: h.id, participant_id: p.id, user_id: u.id,
      data: sub.data, app_id: null, field_schema: SCHEMA,
    }, logger);

    const { rows } = await controlDb.query('SELECT * FROM hackathon_scores WHERE submission_id = $1', [sub.id]);
    expect(Number(rows[0].criterion_demo_url)).toBe(0);
    expect(Number(rows[0].total_score)).toBe(0);
  });

  it('scores features proportionally when app_id is provided', async () => {
    const u = await seedUser('s3@x.com');
    await seedApp(TEST_APP_ID, u.id);
    await seedFeatures(TEST_APP_ID);
    const h = await seedHackathon({ slug: 'sc3', is_active: true, field_schema: SCHEMA });
    const p = await seedParticipant({ hackathon_id: h.id, user_id: u.id });
    const sub = await createSubmission(u.id, h.id, p.id, {
      project_name: 'Test',
      demo_url: 'https://myapp.butterbase.dev',
    }, TEST_APP_ID);

    await scoreSubmission(controlDb, {
      id: sub.id, hackathon_id: h.id, participant_id: p.id, user_id: u.id,
      data: sub.data, app_id: TEST_APP_ID, field_schema: SCHEMA,
    }, logger);

    const { rows } = await controlDb.query('SELECT * FROM hackathon_scores WHERE submission_id = $1', [sub.id]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].criterion_demo_url)).toBe(50);
    expect(Number(rows[0].criterion_features)).toBeGreaterThan(0);
    expect(Number(rows[0].total_score)).toBeGreaterThan(50);

    // Verify feature breakdown
    const breakdown = rows[0].feature_breakdown;
    expect(breakdown.database.count).toBe(1);
    expect(breakdown.database.score).toBeGreaterThan(0);
    expect(breakdown.functions.count).toBe(3);
    expect(breakdown.auth_users.count).toBe(2);
    expect(breakdown.storage.count).toBe(1);
  });

  it('re-scoring upserts (no duplicate rows)', async () => {
    const u = await seedUser('s4@x.com');
    const h = await seedHackathon({ slug: 'sc4', is_active: true, field_schema: SCHEMA });
    const p = await seedParticipant({ hackathon_id: h.id, user_id: u.id });
    const sub = await createSubmission(u.id, h.id, p.id, {
      project_name: 'Test',
      demo_url: 'https://myapp.butterbase.dev',
    });

    const input = {
      id: sub.id, hackathon_id: h.id, participant_id: p.id, user_id: u.id,
      data: sub.data, app_id: null, field_schema: SCHEMA,
    };
    await scoreSubmission(controlDb, input, logger);
    await scoreSubmission(controlDb, input, logger);

    const { rows } = await controlDb.query('SELECT * FROM hackathon_scores WHERE submission_id = $1', [sub.id]);
    expect(rows).toHaveLength(1);
  });

  it('scores URL criterion from is_url field key when not demo_url', async () => {
    const u = await seedUser('s1b@x.com');
    const h = await seedHackathon({ slug: 'sc1b', is_active: true, field_schema: SCHEMA_LIVE_URL });
    const p = await seedParticipant({ hackathon_id: h.id, user_id: u.id });
    const sub = await createSubmission(u.id, h.id, p.id, {
      project_name: 'Test',
      live_demo: 'https://myapp.butterbase.dev',
    });

    await scoreSubmission(controlDb, {
      id: sub.id, hackathon_id: h.id, participant_id: p.id, user_id: u.id,
      data: sub.data, app_id: null, field_schema: SCHEMA_LIVE_URL,
    }, logger);

    const { rows } = await controlDb.query('SELECT * FROM hackathon_scores WHERE submission_id = $1', [sub.id]);
    expect(Number(rows[0].criterion_demo_url)).toBe(50);
  });

  it('resolves the app home region via getRuntimeDbForApp before counting features', async () => {
    const user = await seedUser('rgn-alice@x.com');
    await seedApp(TEST_APP_ID, user.id);
    await seedFeatures(TEST_APP_ID);
    const h = await seedHackathon({ slug: 'rgn-1', is_active: true, field_schema: SCHEMA });
    const p = await seedParticipant({ hackathon_id: h.id, user_id: user.id });
    const sub = await createSubmission(user.id, h.id, p.id, { demo_url: 'https://x.butterbase.dev' }, TEST_APP_ID);

    mockGetRuntimeDbForApp.mockClear();
    await scoreSubmission(controlDb, {
      id: sub.id,
      hackathon_id: h.id,
      participant_id: p.id,
      user_id: user.id,
      data: { demo_url: 'https://x.butterbase.dev' },
      app_id: TEST_APP_ID,
      field_schema: SCHEMA,
    }, logger);

    expect(mockGetRuntimeDbForApp).toHaveBeenCalledTimes(1);
    expect(mockGetRuntimeDbForApp).toHaveBeenCalledWith(controlDb, TEST_APP_ID);

    const { rows } = await controlDb.query(
      'SELECT total_score FROM hackathon_scores WHERE submission_id = $1', [sub.id]
    );
    expect(Number(rows[0].total_score)).toBeGreaterThan(50);
  });

  it('soft-fails when getRuntimeDbForApp throws: features=0, only criterion 1 counts', async () => {
    const user = await seedUser('rgn-bob@x.com');
    const h = await seedHackathon({ slug: 'rgn-2', is_active: true, field_schema: SCHEMA });
    const p = await seedParticipant({ hackathon_id: h.id, user_id: user.id });
    const ghostAppId = '00000000-0000-0000-0000-00000000ffff';
    const sub = await createSubmission(user.id, h.id, p.id, { demo_url: 'https://x.butterbase.dev' }, ghostAppId);

    mockGetRuntimeDbForApp.mockImplementationOnce(async () => {
      throw new Error('AppNotFoundError: ghost-app-id');
    });

    const warnSpy = vi.fn();
    await scoreSubmission(controlDb, {
      id: sub.id,
      hackathon_id: h.id,
      participant_id: p.id,
      user_id: user.id,
      data: { demo_url: 'https://x.butterbase.dev' },
      app_id: ghostAppId,
      field_schema: SCHEMA,
    }, { error: warnSpy });

    const { rows } = await controlDb.query(
      'SELECT total_score, criterion_demo_url, criterion_features FROM hackathon_scores WHERE submission_id = $1', [sub.id]
    );
    expect(Number(rows[0].criterion_demo_url)).toBe(50);
    expect(Number(rows[0].criterion_features)).toBe(0);
    expect(Number(rows[0].total_score)).toBe(50);
    expect(warnSpy).toHaveBeenCalled();
  });
});
