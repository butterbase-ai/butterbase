import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import worker from '../src/worker.js';
import { RedisClient } from '../src/redis-client.js';

const env = {
  CONTROL_API_URL: 'http://ctl-mock',
  INTERNAL_SECRET: 'sek',
  REDIS_HOST_US: 'localhost',
  REDIS_HOST_EU: 'localhost',
  REDIS_PORT_US: '6390',
  REDIS_PORT_EU: '6391',
  REDIS_PORT: '6390',   // fallback
} as any;

const origFetch = globalThis.fetch;

function mockResolveOk(appId: string, region: 'us' | 'eu' = 'us') {
  globalThis.fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/v1/internal/kv/resolve-key')) {
      return new Response(
        JSON.stringify({ app_id: appId, region, redis_password: 'butterbase_dev_kv' }),
        { status: 200 },
      );
    }
    return origFetch(url as any, _init);
  }) as any;
}

beforeAll(async () => {
  // Clear test keys before suite to keep tests reproducible.
  const c = await RedisClient.connect({ host: 'localhost', port: 6390, password: 'butterbase_dev_kv' });
  await c.flushTestDb();   // FLUSHDB on db 0 — be aware this clears the WHOLE db; OK for local dev.
  await c.close();
});

afterAll(() => { globalThis.fetch = origFetch; });

function req(method: string, path: string, body?: unknown) {
  return new Request(`http://gw${path}`, {
    method,
    headers: { authorization: 'Bearer bb_live_x', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('kv-gateway worker', () => {
  it('PUT then GET round-trips', async () => {
    mockResolveOk('app_test');
    const put = await worker.fetch(req('PUT', '/v1/app_test/kv/hello', { value: 'world' }), env);
    expect(put.status).toBe(204);
    const get = await worker.fetch(req('GET', '/v1/app_test/kv/hello'), env);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ value: 'world' });
  });

  it('GET missing key returns 404', async () => {
    mockResolveOk('app_test');
    const get = await worker.fetch(req('GET', '/v1/app_test/kv/missing'), env);
    expect(get.status).toBe(404);
  });

  it('DELETE removes', async () => {
    mockResolveOk('app_test');
    await worker.fetch(req('PUT', '/v1/app_test/kv/tmp', { value: 'x' }), env);
    const del = await worker.fetch(req('DELETE', '/v1/app_test/kv/tmp'), env);
    expect(del.status).toBe(204);
    const get = await worker.fetch(req('GET', '/v1/app_test/kv/tmp'), env);
    expect(get.status).toBe(404);
  });

  it('rejects with 401 when no Authorization', async () => {
    mockResolveOk('app_test');
    const r = new Request('http://gw/v1/app_test/kv/x', { method: 'GET' });
    const res = await worker.fetch(r, env);
    expect(res.status).toBe(401);
  });

  it('rejects with 401 when control-api 404s the key', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 404 })) as any;
    const res = await worker.fetch(req('GET', '/v1/app_test/kv/hello'), env);
    expect(res.status).toBe(401);
  });

  it('rejects invalid key chars with 400', async () => {
    mockResolveOk('app_test');
    const res = await worker.fetch(req('PUT', '/v1/app_test/kv/has space', { value: 'x' }), env);
    expect(res.status).toBe(400);
  });

  it('passes app_id from the URL to resolveApp', async () => {
    // The new resolve-key contract takes app_id. Verify the worker forwards it from the URL.
    let captured: { url: string; body: any } | null = null;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
      return new Response(
        JSON.stringify({ app_id: 'app_other', region: 'us', redis_password: 'butterbase_dev_kv' }),
        { status: 200 },
      );
    }) as any;
    await worker.fetch(req('GET', '/v1/app_other/kv/x'), env);
    expect(captured).not.toBeNull();
    expect(captured!.body).toEqual({ api_key: 'bb_live_x', app_id: 'app_other' });
  });
});
