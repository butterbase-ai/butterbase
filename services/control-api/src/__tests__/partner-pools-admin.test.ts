import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { config } from '../config.js';

if (!process.env.AUTH_ENCRYPTION_KEY) {
  process.env.AUTH_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
}

// Mock requireAdmin in the same style as hackathons-admin.test.ts: real
// admin-auth.ts requires a Bearer JWT, which test injects do not provide.
// We accept "Bearer test-admin" as the dev-owner admin.
vi.mock('../routes/admin-auth.js', () => ({
  requireAdmin: vi.fn(async (
    _app: unknown,
    request: { headers: Record<string, string> },
    reply: { code: (n: number) => { send: (b: unknown) => void } }
  ) => {
    const auth = request.headers['authorization'];
    if (auth === 'Bearer test-admin') return config.devOwnerId;
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }),
}));

const { partnerPoolsAdminRoutes } = await import('../routes/partner-pools-admin.js');

const app = Fastify();
let hackathonId: string;

const inject = (opts: Record<string, unknown>) => {
  const headers = (opts.headers as Record<string, string> | undefined) ?? {};
  return app.inject({
    ...opts,
    headers: { authorization: 'Bearer test-admin', ...headers },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
};

beforeAll(async () => {
  app.register(databasePlugin);
  app.register(partnerPoolsAdminRoutes);
  await app.ready();

  const h = await app.controlDb.query(
    `INSERT INTO hackathons (slug, name, starts_at, ends_at, submission_deadline,
                             field_schema, is_active, submission_code_hash, judge_code_hash)
     VALUES ($1,$2, now(), now() + interval '1 day', now() + interval '1 day',
             '{"version":1,"fields":[]}'::jsonb, false, 'x', 'y') RETURNING id`,
    [`admin-test-${Date.now()}`, 'admin-test']
  );
  hackathonId = h.rows[0].id;
  // Make the test user an admin
  await app.controlDb.query(`UPDATE platform_users SET is_admin = true WHERE id = $1`, [config.devOwnerId]);
});

afterAll(async () => {
  await app.controlDb.query('DELETE FROM hackathons WHERE id = $1', [hackathonId]);
  await app.close();
});

describe('partner-pools admin', () => {
  it('creates a pool', async () => {
    const res = await inject({
      method: 'POST',
      url: `/admin/hackathons/${hackathonId}/partner-pools`,
      payload: {
        slug: 'seedance',
        display_name: 'Seedance',
        base_url: 'https://api.seedance.ai',
        auth_template: { location: 'header', name: 'Authorization', template: 'Bearer {{key}}' },
        contact_message: 'DM @host on Discord.',
      },
    });
    expect(res.statusCode).toBe(201);
    const pool = res.json().pool;
    expect(pool.slug).toBe('seedance');
  });

  it('rejects an invalid auth_template', async () => {
    const res = await inject({
      method: 'POST',
      url: `/admin/hackathons/${hackathonId}/partner-pools`,
      payload: {
        slug: 'broken', display_name: 'X', base_url: 'https://x',
        auth_template: { location: 'header', name: 'Authorization', template: 'no placeholder here' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_AUTH_TEMPLATE');
  });

  it('lists pools for a hackathon', async () => {
    const res = await inject({
      method: 'GET',
      url: `/admin/hackathons/${hackathonId}/partner-pools`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pools.length).toBeGreaterThan(0);
  });

  it('bulk-uploads keys, encrypted', async () => {
    const list = await inject({ method: 'GET', url: `/admin/hackathons/${hackathonId}/partner-pools` });
    const poolId = list.json().pools.find((p: any) => p.slug === 'seedance').id;

    const res = await inject({
      method: 'POST',
      url: `/admin/partner-pools/${poolId}/keys`,
      payload: { keys: ['sk-aaa', 'sk-bbb', 'sk-ccc'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().added).toBe(3);

    const stored = await app.controlDb.query(
      `SELECT encrypted_key FROM partner_keys WHERE pool_id = $1 ORDER BY created_at`,
      [poolId]
    );
    expect(stored.rows.length).toBe(3);
    // Encrypted form: iv:ciphertext:authTag (three colon-separated base64 parts)
    expect(stored.rows[0].encrypted_key.split(':').length).toBe(3);
    expect(stored.rows[0].encrypted_key).not.toContain('sk-aaa');
  });

  it('lists keys with status but no plaintext', async () => {
    const list = await inject({ method: 'GET', url: `/admin/hackathons/${hackathonId}/partner-pools` });
    const poolId = list.json().pools.find((p: any) => p.slug === 'seedance').id;
    const res = await inject({ method: 'GET', url: `/admin/partner-pools/${poolId}/keys` });
    expect(res.statusCode).toBe(200);
    const { keys } = res.json();
    expect(keys.length).toBe(3);
    expect(keys[0]).not.toHaveProperty('encrypted_key');
    expect(keys[0]).not.toHaveProperty('plaintext');
    expect(keys[0]).toHaveProperty('id');
    expect(keys[0]).toHaveProperty('status');
    expect(keys[0]).toHaveProperty('use_count');
  });

  it('revives an exhausted key (admin override)', async () => {
    const list = await inject({ method: 'GET', url: `/admin/hackathons/${hackathonId}/partner-pools` });
    const poolId = list.json().pools.find((p: any) => p.slug === 'seedance').id;

    const k = await app.controlDb.query(
      `UPDATE partner_keys SET status = 'exhausted' WHERE pool_id = $1 RETURNING id`,
      [poolId]
    );
    const keyId = k.rows[0].id;

    const res = await inject({
      method: 'PATCH',
      url: `/admin/partner-pools/${poolId}/keys/${keyId}`,
      payload: { status: 'active' },
    });
    expect(res.statusCode).toBe(200);
    const after = await app.controlDb.query(`SELECT status FROM partner_keys WHERE id = $1`, [keyId]);
    expect(after.rows[0].status).toBe('active');
  });

  it('deletes a pool', async () => {
    const list = await inject({ method: 'GET', url: `/admin/hackathons/${hackathonId}/partner-pools` });
    const poolId = list.json().pools.find((p: any) => p.slug === 'seedance').id;
    const res = await inject({ method: 'DELETE', url: `/admin/partner-pools/${poolId}` });
    expect(res.statusCode).toBe(204);
    const r = await app.controlDb.query(`SELECT count(*)::int n FROM partner_pools WHERE id = $1`, [poolId]);
    expect(r.rows[0].n).toBe(0);
  });
});
