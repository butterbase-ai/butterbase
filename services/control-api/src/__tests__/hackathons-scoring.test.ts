import { describe, expect, it, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { setupTestDb, controlDb, seedUser, seedHackathon, seedParticipant } from './test-helpers/control-db.js';
import { buildApp } from './test-helpers/build-app.js';
import { scoreSubmission } from '../services/hackathons/scoring.js';
import type { FieldSchema } from '../services/hackathons/field-schema.js';

// ── Admin app with mocked auth ─────────────────────────────────────────────
const adminUserId = '00000000-0000-0000-0000-000000000001';

vi.mock('../routes/admin-auth.js', () => ({
  requireAdmin: vi.fn(async (
    _app: unknown,
    request: { headers: Record<string, string> },
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ) => {
    const auth = request.headers['authorization'];
    if (auth === 'Bearer test-admin') return adminUserId;
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }),
}));

const { hackathonsAdminRoutes } = await import('../routes/hackathons-admin.js');

async function buildAdminApp() {
  const app = Fastify({ logger: false });
  app.decorate('controlDb', controlDb);
  await app.register(hackathonsAdminRoutes);
  return app;
}

type AppT = Awaited<ReturnType<typeof buildAdminApp>>;
const adminInject = (app: AppT, opts: Record<string, unknown>) =>
  app.inject({ ...opts, headers: { authorization: 'Bearer test-admin', ...(opts.headers as Record<string, string> ?? {}) } } as never);

// ── Test schema ─────────────────────────────────────────────────────────────
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

// ── Helpers ─────────────────────────────────────────────────────────────────
async function createSubmission(userId: string, hackathonId: string, participantId: string, data: Record<string, unknown>, appId?: string) {
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

async function seedApp(appId: string, ownerId: string) {
  await controlDb.query(
    `INSERT INTO apps (id, name, db_name, owner_id, db_provisioned, region, provisioning_status)
     VALUES ($1, $2, $3, $4, false, 'us-east-1', 'ready')
     ON CONFLICT (id) DO NOTHING`,
    [appId, 'Test App', `db_${appId}`, ownerId],
  );
}

async function seedFeatures(appId: string) {
  // Seed various feature rows so the scoring service can find them
  await controlDb.query(
    `INSERT INTO app_db_connections (app_id, connection_string) VALUES ($1, 'postgresql://fake') ON CONFLICT DO NOTHING`,
    [appId],
  );
  // 3 functions (cap 5 → 3/5 = 0.6)
  for (let i = 0; i < 3; i++) {
    await controlDb.query(
      `INSERT INTO app_functions (id, app_id, name, code, trigger_type)
       VALUES (gen_random_uuid(), $1, $2, 'export default () => {}', 'http')`,
      [appId, `fn_${i}`],
    );
  }
  // 2 app_users (cap 5 → 2/5 = 0.4)
  for (let i = 0; i < 2; i++) {
    await controlDb.query(
      `INSERT INTO app_users (id, app_id, email) VALUES (gen_random_uuid(), $1, $2)`,
      [appId, `user${i}@test.com`],
    );
  }
  // 1 storage object (cap 10 → 1/10 = 0.1)
  await controlDb.query(
    `INSERT INTO storage_objects (id, app_id, bucket, key, size_bytes, content_type)
     VALUES (gen_random_uuid(), $1, 'default', 'file.txt', 100, 'text/plain')`,
    [appId],
  );
}

async function cleanupAppData(appId: string) {
  await controlDb.query('DELETE FROM storage_objects WHERE app_id = $1', [appId]);
  await controlDb.query('DELETE FROM app_users WHERE app_id = $1', [appId]);
  await controlDb.query('DELETE FROM app_functions WHERE app_id = $1', [appId]);
  await controlDb.query('DELETE FROM app_db_connections WHERE app_id = $1', [appId]);
  await controlDb.query('DELETE FROM apps WHERE id = $1', [appId]);
}

const TEST_APP_ID = 'app_scoring_test_001';

// ── Tests ───────────────────────────────────────────────────────────────────
describe('hackathon scoring', () => {
  beforeEach(async () => {
    await setupTestDb();
    await cleanupAppData(TEST_APP_ID);
  });

  describe('scoreSubmission service', () => {
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
  });

  describe('submission route accepts app_id', () => {
    it('POST /hackathons/submissions persists app_id and triggers scoring', async () => {
      const mcpApp = await buildApp();
      const u = await seedUser('r1@x.com');
      await seedApp(TEST_APP_ID, u.id);
      const h = await seedHackathon({ slug: 'rt1', is_active: true, field_schema: SCHEMA });
      await seedParticipant({ hackathon_id: h.id, user_id: u.id });

      const res = await mcpApp.inject({
        method: 'POST',
        url: '/hackathons/submissions',
        headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
        payload: {
          data: { project_name: 'My App', demo_url: 'https://cool.butterbase.dev' },
          app_id: TEST_APP_ID,
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().submission.app_id).toBe(TEST_APP_ID);

      // Wait for setImmediate scoring to complete
      await new Promise(r => setTimeout(r, 200));

      const { rows } = await controlDb.query(
        'SELECT * FROM hackathon_scores WHERE submission_id = $1',
        [res.json().submission.id],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].criterion_demo_url)).toBe(50);
    });
  });

  describe('admin rescore endpoint', () => {
    it('POST /admin/hackathons/:slug/rescore scores all submissions', async () => {
      const adminApp = await buildAdminApp();
      const u1 = await seedUser('a1@x.com');
      const u2 = await seedUser('a2@x.com');
      const h = await seedHackathon({ slug: 'rs1', is_active: true, field_schema: SCHEMA });
      const p1 = await seedParticipant({ hackathon_id: h.id, user_id: u1.id });
      const p2 = await seedParticipant({ hackathon_id: h.id, user_id: u2.id });

      await createSubmission(u1.id, h.id, p1.id, {
        project_name: 'App1', demo_url: 'https://one.butterbase.dev',
      });
      await createSubmission(u2.id, h.id, p2.id, {
        project_name: 'App2', demo_url: 'https://example.com',
      });

      const res = await adminInject(adminApp, {
        method: 'POST',
        url: '/admin/hackathons/rs1/rescore',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.scored).toBe(2);
      expect(body.errors).toBe(0);

      const { rows } = await controlDb.query(
        'SELECT * FROM hackathon_scores WHERE hackathon_id = $1 ORDER BY total_score DESC',
        [h.id],
      );
      expect(rows).toHaveLength(2);
      expect(Number(rows[0].criterion_demo_url)).toBe(50);
      expect(Number(rows[1].criterion_demo_url)).toBe(0);
    });
  });

  describe('admin leaderboard endpoint', () => {
    it('GET /admin/hackathons/:slug/leaderboard returns dense ranking', async () => {
      const adminApp = await buildAdminApp();
      const u1 = await seedUser('lb1@x.com');
      const u2 = await seedUser('lb2@x.com');
      const u3 = await seedUser('lb3@x.com');
      const h = await seedHackathon({ slug: 'lb1', is_active: true, field_schema: SCHEMA });
      const p1 = await seedParticipant({ hackathon_id: h.id, user_id: u1.id });
      const p2 = await seedParticipant({ hackathon_id: h.id, user_id: u2.id });
      const p3 = await seedParticipant({ hackathon_id: h.id, user_id: u3.id });

      // u1 and u2 both have butterbase URLs (50 pts each), u3 does not (0 pts)
      const s1 = await createSubmission(u1.id, h.id, p1.id, {
        project_name: 'App1', demo_url: 'https://one.butterbase.dev',
      });
      const s2 = await createSubmission(u2.id, h.id, p2.id, {
        project_name: 'App2', demo_url: 'https://two.butterbase.dev',
      });
      const s3 = await createSubmission(u3.id, h.id, p3.id, {
        project_name: 'App3', demo_url: 'https://example.com',
      });

      // Score all
      for (const [sub, uid, pid] of [[s1, u1, p1], [s2, u2, p2], [s3, u3, p3]] as const) {
        await scoreSubmission(controlDb, {
          id: (sub as any).id, hackathon_id: h.id,
          participant_id: (pid as any).id, user_id: (uid as any).id,
          data: (sub as any).data, app_id: null, field_schema: SCHEMA,
        }, logger);
      }

      const res = await adminInject(adminApp, {
        method: 'GET',
        url: '/admin/hackathons/lb1/leaderboard',
      });

      expect(res.statusCode).toBe(200);
      const { leaderboard } = res.json();
      expect(leaderboard).toHaveLength(3);

      // u1 and u2 tied at rank 1 (both 50 pts)
      expect(leaderboard[0].rank).toBe(1);
      expect(leaderboard[1].rank).toBe(1);
      expect(Number(leaderboard[0].total_score)).toBe(50);
      expect(Number(leaderboard[1].total_score)).toBe(50);

      // u3 at rank 2 (0 pts)
      expect(leaderboard[2].rank).toBe(2);
      expect(Number(leaderboard[2].total_score)).toBe(0);
    });
  });
});
