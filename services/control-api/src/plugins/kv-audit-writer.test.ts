import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import kvAuditWriter from './kv-audit-writer.js';

const RUN = !!process.env.RUN_DB_TESTS && !!process.env.NEON_PLATFORM_PRIMARY_URL;
const describeDb = RUN ? describe : describe.skip;

describeDb('kv-audit-writer plugin', () => {
  let app: any;
  let pool: any;
  let inserts: any[];

  beforeEach(async () => {
    inserts = [];
    pool = {
      query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.startsWith('INSERT INTO audit_logs')) inserts.push(params);
        return { rows: [] };
      }),
    };
    app = Fastify({ logger: false });
    const fp = (await import('fastify-plugin')).default;
    await app.register(fp(async (i: any) => { i.decorate('controlDb', pool); }, { name: 'shim' }));
    await app.register(kvAuditWriter);
    app.get('/v1/:app_id/kv/:key', async (req: any, reply: any) => {
      const { app_id, key } = req.params;
      if (key === 'fail-413') return reply.code(413).send({ error: 'value_too_large', message: 'too big' });
      if (key === 'fail-429') return reply.code(429).send({ error: 'rate_limited' });
      return reply.code(200).send({ value: 'ok' });
    });
  });

  it('writes an audit row when status is 4xx', async () => {
    await app.ready();
    await app.inject({ method: 'GET', url: '/v1/app_x/kv/fail-413' });
    expect(inserts).toHaveLength(1);
    const [appId, method, path, status, errorCode, errorMessage] = inserts[0];
    expect(appId).toBe('app_x');
    expect(method).toBe('GET');
    expect(path).toBe('/v1/app_x/kv/fail-413');
    expect(status).toBe(413);
    expect(errorCode).toBe('value_too_large');
    expect(errorMessage).toBe('too big');
  });

  it('writes a row for 5xx', async () => {
    app.get('/v1/:app_id/kv/boom', async (_req: any, reply: any) =>
      reply.code(500).send({ error: 'internal' }),
    );
    await app.ready();
    await app.inject({ method: 'GET', url: '/v1/app_x/kv/boom' });
    expect(inserts.some(r => r[3] === 500)).toBe(true);
  });

  it('does NOT write a row for 2xx', async () => {
    await app.ready();
    await app.inject({ method: 'GET', url: '/v1/app_x/kv/ok-key' });
    expect(inserts).toHaveLength(0);
  });

  it('does NOT throw if the DB insert fails', async () => {
    pool.query = vi.fn().mockRejectedValue(new Error('db down'));
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/v1/app_x/kv/fail-413' });
    expect(r.statusCode).toBe(413);
  });

  it('only fires for /v1/:app_id/kv/* paths', async () => {
    app.get('/v1/:app_id/data/foo', async (_req: any, reply: any) =>
      reply.code(403).send({ error: 'forbidden' }),
    );
    await app.ready();
    await app.inject({ method: 'GET', url: '/v1/app_x/data/foo' });
    expect(inserts).toHaveLength(0);
  });
});
