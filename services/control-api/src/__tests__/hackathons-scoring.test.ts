import { describe, expect, it, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { setupTestDb, controlDb, seedUser, seedHackathon, seedParticipant } from './test-helpers/control-db.js';
import { buildApp } from './test-helpers/build-app.js';
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

// Mock scoreSubmission so route tests don't need runtime tables (apps, app_functions, etc.)
// All five scoreSubmission service tests have moved to hackathons-scoring-db.test.ts.
vi.mock('../services/hackathons/scoring.js', () => ({
  scoreSubmission: vi.fn(async () => {}),
}));

// getRuntimeDbForApp mock — scoring is mocked above so this won't be called,
// but the import in region-resolver.js must resolve cleanly.
vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(async () => controlDb),
  AppNotFoundError: class AppNotFoundError extends Error {},
}));

const { hackathonsAdminRoutes } = await import('../routes/hackathons-admin.js');
const { scoreSubmission } = await import('../services/hackathons/scoring.js');

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

// ── Helpers ─────────────────────────────────────────────────────────────────
async function createSubmission(
  userId: string,
  hackathonId: string,
  participantId: string,
  data: Record<string, unknown>,
  appId?: string | null,
) {
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

// app_id has no FK to apps (dropped by migration 072), so we can use any string.
const TEST_APP_ID = 'app_scoring_test_001';

// ── Tests ───────────────────────────────────────────────────────────────────
describe('hackathon scoring (route tests)', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.mocked(scoreSubmission).mockClear();
  });

  describe('submission route accepts app_id', () => {
    it('POST /hackathons/submissions persists app_id and triggers scoring', async () => {
      const mcpApp = await buildApp();
      const u = await seedUser('r1@x.com');
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

      // Wait for setImmediate scoring dispatch to fire
      await new Promise(r => setTimeout(r, 100));

      // scoreSubmission is mocked — assert it was called with the right submission
      expect(vi.mocked(scoreSubmission)).toHaveBeenCalledOnce();
      const callArg = vi.mocked(scoreSubmission).mock.calls[0][1];
      expect(callArg.app_id).toBe(TEST_APP_ID);
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

      // scoreSubmission is mocked — assert it was called once per submission
      expect(vi.mocked(scoreSubmission)).toHaveBeenCalledTimes(2);
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

      // Create submissions (no app_id needed — leaderboard test is about ranking logic)
      const s1 = await createSubmission(u1.id, h.id, p1.id, { project_name: 'App1', demo_url: 'https://one.butterbase.dev' }, null);
      const s2 = await createSubmission(u2.id, h.id, p2.id, { project_name: 'App2', demo_url: 'https://two.butterbase.dev' }, null);
      const s3 = await createSubmission(u3.id, h.id, p3.id, { project_name: 'App3', demo_url: 'https://example.com' }, null);

      // Insert hackathon_scores directly since scoreSubmission is mocked.
      // u1 and u2: 50 pts each (tied at rank 1), u3: 0 pts (rank 2).
      // This tests the dense-ranking logic in the leaderboard endpoint.
      await controlDb.query(
        `INSERT INTO hackathon_scores (submission_id, hackathon_id, participant_id, user_id, criterion_demo_url, criterion_features, total_score, feature_breakdown, scored_at)
         VALUES ($1,$2,$3,$4,50,0,50,'{}',now()),
                ($5,$2,$6,$7,50,0,50,'{}',now()),
                ($8,$2,$9,$10,0,0,0,'{}',now())`,
        [s1.id, h.id, p1.id, u1.id, s2.id, p2.id, u2.id, s3.id, p3.id, u3.id],
      );

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
