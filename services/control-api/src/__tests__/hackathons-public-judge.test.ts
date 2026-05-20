import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { hackathonsPublicRoutes } from '../routes/hackathons-public.js';
import { setupTestDb, controlDb, seedHackathon } from './test-helpers/control-db.js';
import { hashCode } from '../services/hackathons/codes.js';

const COOKIE_SECRET = 'test-secret-for-judge-cookie-signing-32chars!';

const SCHEMA = { fields: [
  { key: 'project_name', type: 'text', required: true, display: 'primary', label: 'Project' },
]};

async function buildJudgeApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: COOKIE_SECRET });
  app.decorate('controlDb', controlDb);
  await app.register(hackathonsPublicRoutes);
  return app;
}

/**
 * Seed a hackathon with a real hashed judge code and return the plaintext code.
 */
async function seedHackathonWithCodes(slug: string, judgeCode: string, isActive = true) {
  const judgeHash = await hashCode(judgeCode);
  return seedHackathon({ slug, is_active: isActive, field_schema: SCHEMA, judge_code_hash: judgeHash });
}

/** Extract the Set-Cookie header value for the bb_judge_* cookie. */
function extractJudgeCookie(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers['set-cookie'];
  if (!raw) return null;
  const cookies = Array.isArray(raw) ? raw : [raw];
  const found = (cookies as string[]).find(c => typeof c === 'string' && c.startsWith('bb_judge_'));
  return found ?? null;
}

describe('public hackathon judge session', () => {
  beforeEach(setupTestDb);

  it('GET /:slug without cookie returns 401 judge_session_required', async () => {
    const app = await buildJudgeApp();
    await seedHackathonWithCodes('h1', 'JUDGE-CODE1');

    const res = await app.inject({ method: 'GET', url: '/v1/public/hackathons/h1' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('judge_session_required');
  });

  it('POST /:slug/judge-session with wrong code returns 401 invalid_judge_code', async () => {
    const app = await buildJudgeApp();
    await seedHackathonWithCodes('h1', 'JUDGE-CODE1');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/public/hackathons/h1/judge-session',
      payload: { code: 'WRONG-CODE1' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_judge_code');
  });

  it('POST /:slug/judge-session with correct code returns 204 + Set-Cookie', async () => {
    const app = await buildJudgeApp();
    await seedHackathonWithCodes('h1', 'JUDGE-CODE1');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/public/hackathons/h1/judge-session',
      payload: { code: 'JUDGE-CODE1' },
    });
    expect(res.statusCode).toBe(204);
    const setCookie = extractJudgeCookie(res);
    expect(setCookie).not.toBeNull();
    expect(setCookie).toMatch(/^bb_judge_/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Max-Age=2592000');
  });

  it('GET /:slug with valid cookie returns 200', async () => {
    const app = await buildJudgeApp();
    await seedHackathonWithCodes('h1', 'JUDGE-CODE1');

    // Log in first.
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/public/hackathons/h1/judge-session',
      payload: { code: 'JUDGE-CODE1' },
    });
    expect(loginRes.statusCode).toBe(204);
    const rawCookie = extractJudgeCookie(loginRes)!;
    // Extract just the name=value part (before the first semicolon).
    const cookieHeader = rawCookie.split(';')[0];

    const res = await app.inject({
      method: 'GET',
      url: '/v1/public/hackathons/h1',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hackathon.slug).toBe('h1');
  });

  it('GET /:slug/submissions with valid cookie returns 200', async () => {
    const app = await buildJudgeApp();
    await seedHackathonWithCodes('h1', 'JUDGE-CODE1');

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/public/hackathons/h1/judge-session',
      payload: { code: 'JUDGE-CODE1' },
    });
    const cookieHeader = extractJudgeCookie(loginRes)!.split(';')[0];

    const res = await app.inject({
      method: 'GET',
      url: '/v1/public/hackathons/h1/submissions',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().submissions).toBeInstanceOf(Array);
  });

  it('GET /:slug/submissions without cookie returns 401', async () => {
    const app = await buildJudgeApp();
    await seedHackathonWithCodes('h1', 'JUDGE-CODE1');

    const res = await app.inject({ method: 'GET', url: '/v1/public/hackathons/h1/submissions' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('judge_session_required');
  });

  it('after rotating judge code, prior cookie returns 401 judge_session_expired', async () => {
    const app = await buildJudgeApp();
    const h = await seedHackathonWithCodes('h1', 'JUDGE-CODE1');

    // Log in with the original code.
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/public/hackathons/h1/judge-session',
      payload: { code: 'JUDGE-CODE1' },
    });
    expect(loginRes.statusCode).toBe(204);
    const cookieHeader = extractJudgeCookie(loginRes)!.split(';')[0];

    // Simulate a code rotation: advance judge_code_set_at and update the hash.
    const newHash = await hashCode('JUDGE-CODE2');
    // Sleep 1 ms to guarantee the timestamp advances.
    await new Promise(r => setTimeout(r, 10));
    await controlDb.query(
      `UPDATE hackathons SET judge_code_hash = $1, judge_code_set_at = now() WHERE id = $2`,
      [newHash, h.id]
    );

    // Old cookie should now 401 with judge_session_expired.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/public/hackathons/h1',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('judge_session_expired');
  });

  it('DELETE /:slug/judge-session clears cookie; gated routes return 401 again', async () => {
    const app = await buildJudgeApp();
    await seedHackathonWithCodes('h1', 'JUDGE-CODE1');

    // Log in.
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/public/hackathons/h1/judge-session',
      payload: { code: 'JUDGE-CODE1' },
    });
    expect(loginRes.statusCode).toBe(204);
    const cookieHeader = extractJudgeCookie(loginRes)!.split(';')[0];

    // Confirm the cookie works.
    const beforeDelete = await app.inject({
      method: 'GET',
      url: '/v1/public/hackathons/h1',
      headers: { cookie: cookieHeader },
    });
    expect(beforeDelete.statusCode).toBe(200);

    // Delete the session.
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/v1/public/hackathons/h1/judge-session',
      headers: { cookie: cookieHeader },
    });
    expect(deleteRes.statusCode).toBe(204);

    // The Set-Cookie on the DELETE response should clear the cookie (Max-Age=0 or Expires in past).
    const clearCookie = extractJudgeCookie(deleteRes);
    expect(clearCookie).not.toBeNull();
    // @fastify/cookie clearCookie sets Max-Age=0 or a past Expires.
    const isCleared = clearCookie!.includes('Max-Age=0') || clearCookie!.includes('Expires=');
    expect(isCleared).toBe(true);

    // Without a valid cookie, gated route returns 401.
    const afterDelete = await app.inject({
      method: 'GET',
      url: '/v1/public/hackathons/h1',
    });
    expect(afterDelete.statusCode).toBe(401);
  });

  it('POST /:slug/judge-session with missing body code returns 400', async () => {
    const app = await buildJudgeApp();
    await seedHackathonWithCodes('h1', 'JUDGE-CODE1');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/public/hackathons/h1/judge-session',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('code_required');
  });

  it('POST /:slug/judge-session for unknown slug returns 404', async () => {
    const app = await buildJudgeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/public/hackathons/nonexistent/judge-session',
      payload: { code: 'JUDGE-CODE1' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('shared submission rating', () => {
  beforeEach(setupTestDb);

  async function login(app: Awaited<ReturnType<typeof buildJudgeApp>>, slug: string, code: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/public/hackathons/${slug}/judge-session`,
      payload: { code },
    });
    return extractJudgeCookie(res)!.split(';')[0];
  }

  async function seedSubmission(hackathonId: string) {
    const { seedUser, seedParticipant } = await import('./test-helpers/control-db.js');
    const u = await seedUser(`p-${Math.random().toString(36).slice(2)}@x.com`);
    const p = await seedParticipant({ hackathon_id: hackathonId, user_id: u.id });
    const { rows } = await controlDb.query<{ id: string }>(
      `INSERT INTO hackathon_submissions (hackathon_id, participant_id, user_id, data)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [hackathonId, p.id, u.id, JSON.stringify({ project_name: 'X' })]
    );
    return rows[0].id;
  }

  it('PUT without judge cookie returns 401', async () => {
    const app = await buildJudgeApp();
    const h = await seedHackathonWithCodes('h1', 'JUDGE-CODE1');
    const subId = await seedSubmission(h.id);

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/public/hackathons/h1/submissions/${subId}/rating`,
      payload: { rating: 4 },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('judge_session_required');
  });

  it('PUT with non-integer / out-of-range rating returns 400', async () => {
    const app = await buildJudgeApp();
    const h = await seedHackathonWithCodes('h1', 'JUDGE-CODE1');
    const subId = await seedSubmission(h.id);
    const cookie = await login(app, 'h1', 'JUDGE-CODE1');

    for (const bad of [-1, 101, 2.5, 'four']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/public/hackathons/h1/submissions/${subId}/rating`,
        headers: { cookie },
        payload: { rating: bad },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_rating');
    }

    // Boundary values: 0 and 100 should be accepted
    for (const good of [0, 100]) {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/public/hackathons/h1/submissions/${subId}/rating`,
        headers: { cookie },
        payload: { rating: good },
      });
      expect(res.statusCode).toBe(204);
    }
  });

  it('PUT upserts and last write wins; list reflects current rating', async () => {
    const app = await buildJudgeApp();
    const h = await seedHackathonWithCodes('h1', 'JUDGE-CODE1');
    const subId = await seedSubmission(h.id);
    const cookie = await login(app, 'h1', 'JUDGE-CODE1');

    const r1 = await app.inject({
      method: 'PUT',
      url: `/v1/public/hackathons/h1/submissions/${subId}/rating`,
      headers: { cookie },
      payload: { rating: 80 },
    });
    expect(r1.statusCode).toBe(204);

    const r2 = await app.inject({
      method: 'PUT',
      url: `/v1/public/hackathons/h1/submissions/${subId}/rating`,
      headers: { cookie },
      payload: { rating: 60 },
    });
    expect(r2.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/public/hackathons/h1/submissions',
      headers: { cookie },
    });
    const found = list.json().submissions.find((s: { id: string }) => s.id === subId);
    expect(found.rating).toBe(60);
  });

  it('list returns rating 0 by default for unrated submissions', async () => {
    const app = await buildJudgeApp();
    const h = await seedHackathonWithCodes('h1', 'JUDGE-CODE1');
    const subId = await seedSubmission(h.id);
    const cookie = await login(app, 'h1', 'JUDGE-CODE1');

    const list = await app.inject({
      method: 'GET',
      url: '/v1/public/hackathons/h1/submissions',
      headers: { cookie },
    });
    const found = list.json().submissions.find((s: { id: string }) => s.id === subId);
    expect(found.rating).toBe(0);
  });

  it('PUT for a submission in a different hackathon returns 404', async () => {
    const app = await buildJudgeApp();
    const h1 = await seedHackathonWithCodes('h1', 'JUDGE-CODE1');
    await seedHackathonWithCodes('h2', 'JUDGE-CODE2', false);
    const subId = await seedSubmission(h1.id);
    const cookie = await login(app, 'h2', 'JUDGE-CODE2');

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/public/hackathons/h2/submissions/${subId}/rating`,
      headers: { cookie },
      payload: { rating: 75 },
    });
    expect(res.statusCode).toBe(404);
  });
});
