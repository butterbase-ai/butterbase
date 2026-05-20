import { describe, expect, it, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { hackathonsPublicRoutes } from '../routes/hackathons-public.js';
import { setupTestDb, controlDb, seedUser, seedHackathon, seedParticipant } from './test-helpers/control-db.js';
import { hashCode } from '../services/hackathons/codes.js';

const COOKIE_SECRET = 'test-secret-for-judge-cookie-signing-32chars!';

const SCHEMA = { fields: [
  { key: 'project_name', type: 'text', required: true,  display: 'primary', label: 'Project' },
  { key: 'demo_url',     type: 'url',  required: true,  display: 'primary', label: 'Demo' },
  { key: 'secret_score', type: 'number', required: false, display: 'private', label: 'S' },
]};

async function buildPublic() {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: COOKIE_SECRET });
  app.decorate('controlDb', controlDb);
  await app.register(hackathonsPublicRoutes);
  return app;
}

async function seedSubmission(hId: string, pId: string, uId: string, data: Record<string, unknown>) {
  await controlDb.query(
    `INSERT INTO hackathon_submissions (hackathon_id, participant_id, user_id, data) VALUES ($1,$2,$3,$4)`,
    [hId, pId, uId, JSON.stringify(data)]
  );
}

/** Log in as a judge and return the cookie header string to pass on subsequent requests. */
async function judgeLogin(app: Awaited<ReturnType<typeof buildPublic>>, slug: string, code: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/public/hackathons/${slug}/judge-session`,
    payload: { code },
  });
  if (res.statusCode !== 204) {
    throw new Error(`Judge login failed: ${res.statusCode} ${res.body}`);
  }
  const raw = res.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw]) as (string | undefined)[];
  const found = cookies.find((c): c is string => typeof c === 'string' && c.startsWith('bb_judge_'));
  if (!found) throw new Error('No judge cookie in response');
  return found.split(';')[0]; // name=value only
}

describe('hackathons-public routes', () => {
  beforeEach(setupTestDb);

  it('GET /v1/public/hackathons/:slug requires judge cookie (returns 401 without it)', async () => {
    const app = await buildPublic();
    await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA });
    const res = await app.inject({ method: 'GET', url: '/v1/public/hackathons/h1' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('judge_session_required');
  });

  it('GET /v1/public/hackathons/:slug returns metadata + schema with valid judge cookie', async () => {
    const app = await buildPublic();
    const judgeCode = 'JUDGE-TEST!1';
    const judgeHash = await hashCode(judgeCode);
    await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA, judge_code_hash: judgeHash });
    const cookieHeader = await judgeLogin(app, 'h1', judgeCode);

    const res = await app.inject({
      method: 'GET', url: '/v1/public/hackathons/h1',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.hackathon.slug).toBe('h1');
    expect(json.field_schema.fields).toHaveLength(3);
    expect(json.submission_count).toBe(0);
  });

  it('GET /:slug/submissions strips display:private fields', async () => {
    const app = await buildPublic();
    const judgeCode = 'JUDGE-TEST!2';
    const judgeHash = await hashCode(judgeCode);
    const u = await seedUser('a@x.com');
    const h = await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA, judge_code_hash: judgeHash });
    const p = await seedParticipant({ hackathon_id: h.id, email: 'a@x.com', user_id: u.id, status: 'active' });
    await seedSubmission(h.id, p.id, u.id, { project_name: 'X', demo_url: 'https://x.dev', secret_score: 99 });

    const cookieHeader = await judgeLogin(app, 'h1', judgeCode);
    const res = await app.inject({
      method: 'GET', url: '/v1/public/hackathons/h1/submissions',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const sub = res.json().submissions[0];
    expect(sub.data.project_name).toBe('X');
    expect(sub.data.secret_score).toBeUndefined();
  });

  it('returns 404 for unknown slug', async () => {
    const app = await buildPublic();
    const res = await app.inject({ method: 'GET', url: '/v1/public/hackathons/missing' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/public/hackathons/active returns a hackathon in its submission window or 404 (no cookie required)', async () => {
    const app = await buildPublic();
    const res404 = await app.inject({ method: 'GET', url: '/v1/public/hackathons/active' });
    expect(res404.statusCode).toBe(404);

    await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA });
    const res = await app.inject({ method: 'GET', url: '/v1/public/hackathons/active' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hackathon.slug).toBe('h1');
    // Active endpoint is trimmed: no field_schema, no submission_count.
    expect(body.field_schema).toBeUndefined();
    expect(body.submission_count).toBeUndefined();
  });

  it('GET /v1/public/hackathons/active returns 200 for in-window hackathon even when is_active is false', async () => {
    const app = await buildPublic();
    await seedHackathon({ slug: 'h-not-flagged', is_active: false, field_schema: SCHEMA });
    const res = await app.inject({ method: 'GET', url: '/v1/public/hackathons/active' });
    expect(res.statusCode).toBe(200);
    expect(res.json().hackathon.slug).toBe('h-not-flagged');
  });

  it('GET /v1/public/hackathons/active returns 404 when submission_deadline has passed', async () => {
    const app = await buildPublic();
    await seedHackathon({
      slug: 'h-closed',
      is_active: true,
      field_schema: SCHEMA,
      starts_at: new Date(Date.now() - 86_400_000),
      submission_deadline: new Date(Date.now() - 60_000),
      ends_at: new Date(Date.now() - 30_000),
    });
    const res = await app.inject({ method: 'GET', url: '/v1/public/hackathons/active' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/public/hackathons/active prefers latest-started when multiple hackathons are in window', async () => {
    const app = await buildPublic();
    const earlier = new Date(Date.now() - 7 * 86_400_000);
    const later   = new Date(Date.now() - 1 * 86_400_000);
    const ends    = new Date(Date.now() + 7 * 86_400_000);
    await seedHackathon({
      slug: 'h-earlier', is_active: true, field_schema: SCHEMA,
      starts_at: earlier, ends_at: ends, submission_deadline: ends,
    });
    await seedHackathon({
      slug: 'h-later', is_active: false, field_schema: SCHEMA,
      starts_at: later, ends_at: ends, submission_deadline: ends,
    });
    const res = await app.inject({ method: 'GET', url: '/v1/public/hackathons/active' });
    expect(res.statusCode).toBe(200);
    expect(res.json().hackathon.slug).toBe('h-later');
  });
});
