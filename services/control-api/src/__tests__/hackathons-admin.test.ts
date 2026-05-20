import { describe, expect, it, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { setupTestDb, controlDb, seedHackathon } from './test-helpers/control-db.js';
import { verifyCode } from '../services/hackathons/codes.js';

const adminUserId = '00000000-0000-0000-0000-000000000001';

vi.mock('../routes/admin-auth.js', () => ({
  requireAdmin: vi.fn(async (
    _app: unknown,
    request: { headers: Record<string, string> },
    reply: { code: (n: number) => { send: (b: unknown) => void } }
  ) => {
    const auth = request.headers['authorization'];
    if (auth === 'Bearer test-admin') return adminUserId;
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }),
}));

const { hackathonsAdminRoutes } = await import('../routes/hackathons-admin.js');

const SCHEMA = { fields: [
  { key: 'project_name', type: 'text', required: true, display: 'primary', label: 'Project' }
]};

async function buildAdminApp() {
  const app = Fastify({ logger: false });
  app.decorate('controlDb', controlDb);
  await app.register(hackathonsAdminRoutes);
  return app;
}

type AppT = Awaited<ReturnType<typeof buildAdminApp>>;

const inject = (app: AppT, opts: Record<string, unknown>) => {
  const headers = (opts.headers as Record<string, string> | undefined) ?? {};
  return app.inject({
    ...opts,
    headers: { authorization: 'Bearer test-admin', ...headers },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
};

describe('hackathons-admin routes', () => {
  beforeEach(async () => {
    await setupTestDb();
    await controlDb.query(
      `INSERT INTO platform_users (id, email, created_at) VALUES ($1, 'admin-test@x.com', now()) ON CONFLICT (id) DO NOTHING`,
      [adminUserId]
    );
  });

  it('POST /admin/hackathons creates a hackathon', async () => {
    const app = await buildAdminApp();
    const res = await inject(app, {
      method: 'POST',
      url: '/admin/hackathons',
      payload: {
        slug: 'h1', name: 'H1',
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        submission_deadline: new Date(Date.now() + 86400_000).toISOString(),
        field_schema: SCHEMA,
        is_active: false,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().hackathon.slug).toBe('h1');
  });

  it('rejects invalid field_schema', async () => {
    const app = await buildAdminApp();
    const res = await inject(app, {
      method: 'POST', url: '/admin/hackathons',
      payload: {
        slug: 'h1', name: 'H1',
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        submission_deadline: new Date(Date.now() + 86400_000).toISOString(),
        field_schema: { fields: [{ key: 'X', type: 'banana', required: false, display: 'primary', label: 'L' }] },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_field_schema');
  });

  it('POST /admin/hackathons/:slug/activate atomically deactivates others', async () => {
    const app = await buildAdminApp();
    await seedHackathon({ slug: 'a', is_active: true, field_schema: SCHEMA });
    const b = await seedHackathon({ slug: 'b', is_active: false, field_schema: SCHEMA });
    const res = await inject(app, { method: 'POST', url: '/admin/hackathons/b/activate' });
    expect(res.statusCode).toBe(200);
    const { rows } = await controlDb.query('SELECT slug, is_active FROM hackathons ORDER BY slug');
    expect(rows).toEqual([{ slug: 'a', is_active: false }, { slug: 'b', is_active: true }]);
    void b;
  });

  it('GET /admin/hackathons/:slug returns single hackathon', async () => {
    const app = await buildAdminApp();
    await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA });
    const res = await inject(app, { method: 'GET', url: '/admin/hackathons/h1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().hackathon.slug).toBe('h1');

    const res404 = await inject(app, { method: 'GET', url: '/admin/hackathons/missing' });
    expect(res404.statusCode).toBe(404);
  });

});

describe('hackathon admin codes', () => {
  beforeEach(async () => {
    await setupTestDb();
    await controlDb.query(
      `INSERT INTO platform_users (id, email, created_at) VALUES ($1, 'admin-test@x.com', now()) ON CONFLICT (id) DO NOTHING`,
      [adminUserId]
    );
  });

  it('POST /admin/hackathons returns plaintext codes when none supplied (auto-gen)', async () => {
    const app = await buildAdminApp();
    const res = await inject(app, {
      method: 'POST',
      url: '/admin/hackathons',
      payload: {
        slug: 'h-autogen', name: 'Auto-gen Hackathon',
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        submission_deadline: new Date(Date.now() + 86400_000).toISOString(),
        field_schema: SCHEMA,
        is_active: false,
      },
    });
    expect(res.statusCode).toBe(201);
    const { hackathon } = res.json();

    // Response must include plaintext codes in the auto-generated format.
    expect(hackathon.submission_code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(hackathon.judge_code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);

    // Hashes must NOT be exposed in the response.
    expect(hackathon.submission_code_hash).toBeUndefined();
    expect(hackathon.judge_code_hash).toBeUndefined();

    // DB row must store hashes, not plaintext.
    const { rows } = await controlDb.query(
      `SELECT submission_code_hash, judge_code_hash FROM hackathons WHERE slug = $1`,
      ['h-autogen']
    );
    expect(rows[0].submission_code_hash).not.toBe(hackathon.submission_code);
    expect(rows[0].judge_code_hash).not.toBe(hackathon.judge_code);

    // Hashes must verify correctly against the returned plaintext.
    expect(await verifyCode(hackathon.submission_code, rows[0].submission_code_hash)).toBe(true);
    expect(await verifyCode(hackathon.judge_code, rows[0].judge_code_hash)).toBe(true);
  });

  it('POST /admin/hackathons accepts custom codes and returns them in response', async () => {
    const app = await buildAdminApp();
    const res = await inject(app, {
      method: 'POST',
      url: '/admin/hackathons',
      payload: {
        slug: 'h-custom', name: 'Custom Code Hackathon',
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        submission_deadline: new Date(Date.now() + 86400_000).toISOString(),
        field_schema: SCHEMA,
        submission_code: 'CUSTOM-12345',
        judge_code: 'JUDGES-OK!9',
      },
    });
    expect(res.statusCode).toBe(201);
    const { hackathon } = res.json();
    expect(hackathon.submission_code).toBe('CUSTOM-12345');
    expect(hackathon.judge_code).toBe('JUDGES-OK!9');
    expect(hackathon.submission_code_hash).toBeUndefined();
    expect(hackathon.judge_code_hash).toBeUndefined();
  });

  it('POST /admin/hackathons rejects codes shorter than 8 chars with 400 invalid_code_format', async () => {
    const app = await buildAdminApp();
    const res = await inject(app, {
      method: 'POST',
      url: '/admin/hackathons',
      payload: {
        slug: 'h-bad', name: 'Bad Code Hackathon',
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        submission_deadline: new Date(Date.now() + 86400_000).toISOString(),
        field_schema: SCHEMA,
        submission_code: 'short',  // only 5 chars — invalid
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_code_format');
    expect(res.json().reason).toBe('too_short');
  });

  it('POST /admin/hackathons/:slug/rotate-code (kind: submission) returns new plaintext, advances set_at', async () => {
    const app = await buildAdminApp();
    // Create a hackathon first.
    const createRes = await inject(app, {
      method: 'POST',
      url: '/admin/hackathons',
      payload: {
        slug: 'h-rotate', name: 'Rotate Test',
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        submission_deadline: new Date(Date.now() + 86400_000).toISOString(),
        field_schema: SCHEMA,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const oldCode = createRes.json().hackathon.submission_code;

    // Small delay to ensure set_at advances.
    await new Promise(r => setTimeout(r, 50));

    const rotateRes = await inject(app, {
      method: 'POST',
      url: '/admin/hackathons/h-rotate/rotate-code',
      payload: { kind: 'submission' },
    });
    expect(rotateRes.statusCode).toBe(200);
    const { kind, code, set_at } = rotateRes.json();
    expect(kind).toBe('submission');
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(code).not.toBe(oldCode);
    expect(set_at).toBeDefined();

    // Verify the new hash is stored and old plaintext no longer verifies.
    const { rows } = await controlDb.query(
      `SELECT submission_code_hash FROM hackathons WHERE slug = 'h-rotate'`
    );
    expect(await verifyCode(code, rows[0].submission_code_hash)).toBe(true);
    expect(await verifyCode(oldCode, rows[0].submission_code_hash)).toBe(false);
  });

  it('POST /admin/hackathons/:slug/rotate-code with custom value uses that value', async () => {
    const app = await buildAdminApp();
    await inject(app, {
      method: 'POST',
      url: '/admin/hackathons',
      payload: {
        slug: 'h-custom-rotate', name: 'Custom Rotate',
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        submission_deadline: new Date(Date.now() + 86400_000).toISOString(),
        field_schema: SCHEMA,
      },
    });

    const res = await inject(app, {
      method: 'POST',
      url: '/admin/hackathons/h-custom-rotate/rotate-code',
      payload: { kind: 'judge', value: 'MyJudgePass#1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('judge');
    expect(res.json().code).toBe('MyJudgePass#1');

    const { rows } = await controlDb.query(
      `SELECT judge_code_hash FROM hackathons WHERE slug = 'h-custom-rotate'`
    );
    expect(await verifyCode('MyJudgePass#1', rows[0].judge_code_hash)).toBe(true);
  });

  it('POST /admin/hackathons/:slug/rotate-code requires admin (403 without valid token)', async () => {
    const app = await buildAdminApp();
    await inject(app, {
      method: 'POST',
      url: '/admin/hackathons',
      payload: {
        slug: 'h-noauth', name: 'No Auth',
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        submission_deadline: new Date(Date.now() + 86400_000).toISOString(),
        field_schema: SCHEMA,
      },
    });

    // Use a non-admin token.
    const res = await app.inject({
      method: 'POST',
      url: '/admin/hackathons/h-noauth/rotate-code',
      headers: { authorization: 'Bearer not-admin' },
      payload: { kind: 'submission' },
    });
    expect(res.statusCode).toBe(403);
  });
});
