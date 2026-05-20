import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import { initRoutes } from '../routes/init.js';
import { partnerProxyRoutes } from '../routes/partner-proxy.js';
import { encrypt } from '../services/crypto.js';
import { config } from '../config.js';

if (!process.env.AUTH_ENCRYPTION_KEY) {
  process.env.AUTH_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
}
const ENC_KEY = process.env.AUTH_ENCRYPTION_KEY;
const app = Fastify();
let appId: string;
let hackathonId: string;
let hackathonSlug: string;
let poolId: string;
const TEST_USER = config.devOwnerId;

beforeAll(async () => {
  app.decorateRequest('auth', null as any);
  app.addHook('onRequest', async (request) => {
    (request as any).auth = {
      userId: TEST_USER,
      authMethod: 'api_key',
      scopes: ['*'],
    };
  });

  app.register(databasePlugin);
  app.register(dataPlanePlugin);
  app.register(initRoutes);
  app.register(partnerProxyRoutes);
  await app.ready();

  const init = await app.inject({ method: 'POST', url: '/init', payload: { name: `proxy-test-${Date.now()}` } });
  appId = init.json().app_id;
  for (let i = 0; i < 30; i++) {
    const s = await app.inject({ method: 'GET', url: `/apps/${appId}/status` });
    if (s.json().provisioning_status === 'ready') break;
    await new Promise((r) => setTimeout(r, 200));
  }

  await app.controlDb.query(
    `INSERT INTO platform_users (id, email, created_at) VALUES ($1, 'proxy-route-test@x.com', now()) ON CONFLICT (id) DO NOTHING`,
    [TEST_USER]
  );

  // Deactivate any pre-existing active hackathon (dev DB constraint allows only one).
  await app.controlDb.query(`UPDATE hackathons SET is_active = false WHERE is_active = true`);

  hackathonSlug = `proxy-route-${Date.now()}`;
  const h = await app.controlDb.query(
    `INSERT INTO hackathons (slug, name, starts_at, ends_at, submission_deadline,
                             field_schema, is_active, submission_code_hash, judge_code_hash)
     VALUES ($1,$2, now() - interval '1 hour', now() + interval '1 day', now() + interval '1 day',
             '{"version":1,"fields":[]}'::jsonb, true, 'x', 'y') RETURNING id`,
    [hackathonSlug, 'proxy-route']
  );
  hackathonId = h.rows[0].id;

  await app.controlDb.query(
    `INSERT INTO hackathon_participants (hackathon_id, email, user_id, source, status)
     VALUES ($1,'dev@test.local',$2,'admin_panel','active')`,
    [hackathonId, TEST_USER]
  );

  const p = await app.controlDb.query(
    `INSERT INTO partner_pools (hackathon_id, slug, display_name, base_url, auth_template, contact_message)
     VALUES ($1,'demo','Demo','https://demo.example.com',
             '{"location":"header","name":"Authorization","template":"Bearer {{key}}"}'::jsonb,
             'Ping @host on Discord.') RETURNING id`,
    [hackathonId]
  );
  poolId = p.rows[0].id;
});

afterAll(async () => {
  await app.controlDb.query('DELETE FROM hackathons WHERE id = $1', [hackathonId]);
  await app.controlDb.query(`DELETE FROM hackathons WHERE slug = $1`, ['hackathon-b']);
  await app.close();
});

beforeEach(async () => {
  await app.controlDb.query('DELETE FROM partner_keys WHERE pool_id = $1', [poolId]);
  await app.controlDb.query(`UPDATE hackathons SET is_active = true WHERE id = $1`, [hackathonId]);
  vi.restoreAllMocks();
});

describe('partner-proxy route', () => {
  it('forwards POST and returns partner response', async () => {
    await app.controlDb.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`,
      [poolId, encrypt('partner-1', ENC_KEY)]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"echo":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    );

    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/partners/${hackathonSlug}/demo/v1/echo`,
      payload: { hello: 'world' },
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ echo: true });
  });

  it('forwards path + querystring verbatim', async () => {
    await app.controlDb.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`,
      [poolId, encrypt('partner-1', ENC_KEY)]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await app.inject({ method: 'GET', url: `/v1/${appId}/partners/${hackathonSlug}/demo/v1/things?limit=5&q=hi` });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://demo.example.com/v1/things?limit=5&q=hi');
  });

  it('returns 503 PARTNER_QUOTA_EXHAUSTED when all keys are dead', async () => {
    await app.controlDb.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`,
      [poolId, encrypt('a', ENC_KEY)]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('quota', { status: 429 }));

    const res = await app.inject({ method: 'POST', url: `/v1/${appId}/partners/${hackathonSlug}/demo/v1/x`, payload: {} });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error.code).toBe('PARTNER_QUOTA_EXHAUSTED');
    expect(body.error.remediation).toContain('Ping @host on Discord');
    expect(body.error.partner).toBe('demo');
  });

  it('returns 503 when no keys exist at all', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/${appId}/partners/${hackathonSlug}/demo/v1/x` });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('PARTNER_QUOTA_EXHAUSTED');
  });

  it('returns 404 PARTNER_NOT_FOUND when slug does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/${appId}/partners/${hackathonSlug}/unknown/v1/x` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PARTNER_NOT_FOUND');
  });

  it('returns 403 NOT_HACKATHON_PARTICIPANT when user is not a participant', async () => {
    await app.controlDb.query(
      `UPDATE hackathon_participants SET status = 'revoked'
       WHERE hackathon_id = $1 AND user_id = $2`,
      [hackathonId, TEST_USER]
    );
    const res = await app.inject({ method: 'GET', url: `/v1/${appId}/partners/${hackathonSlug}/demo/v1/x` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_HACKATHON_PARTICIPANT');
    // restore
    await app.controlDb.query(
      `UPDATE hackathon_participants SET status = 'active'
       WHERE hackathon_id = $1 AND user_id = $2`,
      [hackathonId, TEST_USER]
    );
  });

  it('returns 404 HACKATHON_NOT_FOUND when hackathon slug does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/${appId}/partners/nonexistent-hackathon/demo/v1/x` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('HACKATHON_NOT_FOUND');
  });

  it('passes upstream response headers through except blocklisted ones', async () => {
    await app.controlDb.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`,
      [poolId, encrypt('hdr-test', ENC_KEY)]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'x-rate-limit-remaining': '42',
          'transfer-encoding': 'chunked',
          'connection': 'keep-alive',
          'set-cookie': 'sid=abc; HttpOnly',
          'strict-transport-security': 'max-age=31536000',
          'content-security-policy': "default-src 'self'",
        },
      })
    );

    const res = await app.inject({ method: 'GET', url: `/v1/${appId}/partners/${hackathonSlug}/demo/v1/x` });
    expect(res.statusCode).toBe(200);
    // Allowed: content-type, x-rate-limit-remaining
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['x-rate-limit-remaining']).toBe('42');
    // Blocklisted partner headers must not be forwarded. We only verify the
    // partner's value did not pass through — Fastify itself manages
    // hop-by-hop headers (transfer-encoding/connection) on the response.
    expect(res.headers['transfer-encoding']).not.toBe('chunked');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('logs to partner_proxy_logs on success', async () => {
    await app.controlDb.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`,
      [poolId, encrypt('a', ENC_KEY)]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    const before = (await app.controlDb.query(`SELECT count(*)::int n FROM partner_proxy_logs WHERE pool_id = $1`, [poolId])).rows[0].n;
    await app.inject({ method: 'POST', url: `/v1/${appId}/partners/${hackathonSlug}/demo/v1/x`, payload: { a: 1 } });
    // Logging is fire-and-forget; allow a tick.
    await new Promise((r) => setTimeout(r, 100));
    const after = (await app.controlDb.query(`SELECT count(*)::int n FROM partner_proxy_logs WHERE pool_id = $1`, [poolId])).rows[0].n;
    expect(after).toBe(before + 1);
  });

  it('returns 403 NOT_HACKATHON_PARTICIPANT when caller is in a different hackathon than the URL names', async () => {
    const hBId = randomUUID();
    await app.controlDb.query(
      `INSERT INTO hackathons (id, slug, name, starts_at, ends_at, submission_deadline,
                               field_schema, is_active, submission_code_hash, judge_code_hash)
       VALUES ($1,$2,$2, now() - interval '1 day', now() + interval '7 days',
               now() + interval '7 days', '{"fields":[]}', false, 'h', 'h')`,
      [hBId, 'hackathon-b'],
    );
    await app.controlDb.query(
      `INSERT INTO partner_pools (hackathon_id, slug, display_name, base_url, auth_template, contact_message)
       VALUES ($1, 'echo', 'Echo', 'https://example.test', $2, 'contact us')`,
      [hBId, JSON.stringify({ location: 'header', name: 'Authorization', template: 'Bearer {{key}}' })],
    );

    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/partners/hackathon-b/echo/v1/anything`,
      headers: { 'content-type': 'application/json' },
      payload: { hello: 'world' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_HACKATHON_PARTICIPANT');
  });
});
