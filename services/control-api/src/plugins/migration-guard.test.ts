import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import migrationGuardPlugin from './migration-guard.js';

const fakeRedis = () => {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); return 'OK'; }),
    del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
  };
};

describe('migration-guard plugin', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    process.env.BUTTERBASE_REGION = 'us-east-1';
    app = Fastify();
    const runtimePool: any = {
      query: vi.fn().mockImplementation(async (_sql: string, [appId]: [string]) => {
        if (appId === 'app-mig') return { rows: [{ provisioning_status: 'migrating' }] };
        if (appId === 'app-ok') return { rows: [{ provisioning_status: 'ready' }] };
        return { rows: [] };
      }),
    };
    app.decorate('runtimeDb', () => runtimePool);
    app.decorate('redis', fakeRedis());
    await app.register(migrationGuardPlugin);
    app.get<{ Params: { app_id: string } }>('/v1/:app_id/read', { config: { migrationGuard: true } }, async () => ({ ok: true }));
    app.post<{ Params: { app_id: string } }>('/v1/:app_id/write', { config: { migrationGuard: true } }, async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  it('serves reads even when migrating', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/app-mig/read' });
    expect(r.statusCode).toBe(200);
  });

  it('blocks writes with 503 when migrating', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/app-mig/write' });
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('60');
  });

  it('serves writes when not migrating', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/app-ok/write' });
    expect(r.statusCode).toBe(200);
  });
});
