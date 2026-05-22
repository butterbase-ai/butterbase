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

  // ── incr ────────────────────────────────────────────────────────────────────

  describe('incr', () => {
    it('increments by default 1', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('POST', '/v1/app_test/kv/counter-incr/incr', {}), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ value: 1 });
    });

    it('increments by custom amount', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('POST', '/v1/app_test/kv/counter-incr/incr', { by: 5 }), env);
      expect(res.status).toBe(200);
      const body = await res.json() as { value: number };
      expect(body.value).toBe(6); // 1 from previous test + 5
    });

    it('returns 405 for wrong method', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('GET', '/v1/app_test/kv/counter-incr/incr'), env);
      expect(res.status).toBe(405);
    });
  });

  // ── decr ────────────────────────────────────────────────────────────────────

  describe('decr', () => {
    it('decrements by default 1', async () => {
      mockResolveOk('app_test');
      // Use a fresh key initialized via incr (starts at 0, incr makes 1, decr brings back to 0)
      await worker.fetch(req('POST', '/v1/app_test/kv/counter-decr/incr', {}), env);
      const res = await worker.fetch(req('POST', '/v1/app_test/kv/counter-decr/decr', {}), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ value: 0 });
    });

    it('decrements by custom amount', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('POST', '/v1/app_test/kv/counter-decr/decr', { by: 3 }), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ value: -3 });
    });

    it('returns 405 for wrong method', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('GET', '/v1/app_test/kv/counter-decr/decr'), env);
      expect(res.status).toBe(405);
    });
  });

  // ── setnx ───────────────────────────────────────────────────────────────────

  describe('setnx', () => {
    it('writes when key absent — returns 201 and { wrote: true }', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(
        req('POST', '/v1/app_test/kv/setnx-key/setnx', { value: 'initial' }),
        env,
      );
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ wrote: true });
    });

    it('does not overwrite existing key — returns 200 and { wrote: false }', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(
        req('POST', '/v1/app_test/kv/setnx-key/setnx', { value: 'overwrite' }),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ wrote: false });

      // Confirm value unchanged
      mockResolveOk('app_test');
      const get = await worker.fetch(req('GET', '/v1/app_test/kv/setnx-key'), env);
      expect(await get.json()).toEqual({ value: 'initial' });
    });

    it('returns 405 for wrong method', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('GET', '/v1/app_test/kv/setnx-key/setnx'), env);
      expect(res.status).toBe(405);
    });
  });

  // ── cas ─────────────────────────────────────────────────────────────────────

  describe('cas', () => {
    it('swaps when expected=null and key is absent', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(
        req('POST', '/v1/app_test/kv/cas-key/cas', { expected: null, next: 'v1' }),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ swapped: true });

      mockResolveOk('app_test');
      const get = await worker.fetch(req('GET', '/v1/app_test/kv/cas-key'), env);
      expect(await get.json()).toEqual({ value: 'v1' });
    });

    it('does not swap when expected=null but key already exists', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(
        req('POST', '/v1/app_test/kv/cas-key/cas', { expected: null, next: 'v-wrong' }),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ swapped: false });

      mockResolveOk('app_test');
      const get = await worker.fetch(req('GET', '/v1/app_test/kv/cas-key'), env);
      expect(await get.json()).toEqual({ value: 'v1' }); // unchanged
    });

    it('swaps when expected matches current value', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(
        req('POST', '/v1/app_test/kv/cas-key/cas', { expected: 'v1', next: 'v2' }),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ swapped: true });

      mockResolveOk('app_test');
      const get = await worker.fetch(req('GET', '/v1/app_test/kv/cas-key'), env);
      expect(await get.json()).toEqual({ value: 'v2' });
    });

    it('does not swap when expected is wrong', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(
        req('POST', '/v1/app_test/kv/cas-key/cas', { expected: 'stale', next: 'v3' }),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ swapped: false });

      mockResolveOk('app_test');
      const get = await worker.fetch(req('GET', '/v1/app_test/kv/cas-key'), env);
      expect(await get.json()).toEqual({ value: 'v2' }); // unchanged
    });

    it('returns 405 for wrong method', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('GET', '/v1/app_test/kv/cas-key/cas'), env);
      expect(res.status).toBe(405);
    });
  });

  // ── expire ───────────────────────────────────────────────────────────────────

  describe('expire', () => {
    it('returns { ok: true } when key exists and ttl is set', async () => {
      mockResolveOk('app_test');
      await worker.fetch(req('PUT', '/v1/app_test/kv/expire-key', { value: 'x' }), env);

      mockResolveOk('app_test');
      const res = await worker.fetch(
        req('POST', '/v1/app_test/kv/expire-key/expire', { ttl: 9999 }),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it('returns { ok: false } when key does not exist', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(
        req('POST', '/v1/app_test/kv/expire-missing/expire', { ttl: 60 }),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false });
    });

    it('accepts ttl: null to persist', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(
        req('POST', '/v1/app_test/kv/expire-key/expire', { ttl: null }),
        env,
      );
      expect(res.status).toBe(200);
      // PERSIST on a key that has a TTL returns 1 (true); on one that doesn't it returns 0 (false).
      // Either is valid; just check shape.
      const body = await res.json() as { ok: boolean };
      expect(typeof body.ok).toBe('boolean');
    });

    it('returns 405 for wrong method', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('GET', '/v1/app_test/kv/expire-key/expire'), env);
      expect(res.status).toBe(405);
    });
  });

  // ── ttl ──────────────────────────────────────────────────────────────────────

  describe('ttl', () => {
    it('returns { ttl: null } for a key with no expiry', async () => {
      mockResolveOk('app_test');
      await worker.fetch(req('PUT', '/v1/app_test/kv/ttl-perm', { value: 1 }), env);

      mockResolveOk('app_test');
      const res = await worker.fetch(req('GET', '/v1/app_test/kv/ttl-perm/ttl'), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ttl: null });
    });

    it('returns { ttl: number } for a key with expiry', async () => {
      mockResolveOk('app_test');
      await worker.fetch(req('PUT', '/v1/app_test/kv/ttl-exp', { value: 1 }), env);
      mockResolveOk('app_test');
      await worker.fetch(req('POST', '/v1/app_test/kv/ttl-exp/expire', { ttl: 500 }), env);

      mockResolveOk('app_test');
      const res = await worker.fetch(req('GET', '/v1/app_test/kv/ttl-exp/ttl'), env);
      expect(res.status).toBe(200);
      const body = await res.json() as { ttl: number };
      expect(body.ttl).toBeGreaterThan(0);
      expect(body.ttl).toBeLessThanOrEqual(500);
    });

    it('returns 404 for a missing key', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('GET', '/v1/app_test/kv/ttl-missing/ttl'), env);
      expect(res.status).toBe(404);
    });

    it('returns 405 for wrong method', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('POST', '/v1/app_test/kv/ttl-perm/ttl', {}), env);
      expect(res.status).toBe(405);
    });
  });

  // ── exists ───────────────────────────────────────────────────────────────────

  describe('exists', () => {
    it('returns { exists: true } for a present key', async () => {
      mockResolveOk('app_test');
      await worker.fetch(req('PUT', '/v1/app_test/kv/exists-key', { value: 'y' }), env);

      mockResolveOk('app_test');
      const res = await worker.fetch(req('GET', '/v1/app_test/kv/exists-key/exists'), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ exists: true });
    });

    it('returns { exists: false } for a missing key', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('GET', '/v1/app_test/kv/exists-absent/exists'), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ exists: false });
    });

    it('returns 405 for wrong method', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('POST', '/v1/app_test/kv/exists-key/exists', {}), env);
      expect(res.status).toBe(405);
    });
  });

  // ── _batch ───────────────────────────────────────────────────────────────────

  describe('_batch', () => {
    it('handles get/set/del ops and returns results in order', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(
        req('POST', '/v1/app_test/kv/_batch', {
          ops: [
            { op: 'set', key: 'batch-a', value: 42 },
            { op: 'get', key: 'batch-a' },
            { op: 'del', key: 'batch-a' },
            { op: 'get', key: 'batch-a' },
          ],
        }),
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { results: unknown[] };
      expect(body.results).toEqual([
        { ok: true },
        { value: 42 },
        { deleted: 1 },
        { value: null },
      ]);
    });

    it('returns { error } for invalid ops without aborting the batch', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(
        req('POST', '/v1/app_test/kv/_batch', {
          ops: [
            { op: 'set', key: 'batch-b', value: 'good' },
            { op: 'noop', key: 'batch-b' },         // invalid op
            { op: 'get', key: 'has space' },          // invalid key
            { op: 'get', key: 'batch-b' },
          ],
        }),
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { results: unknown[] };
      expect(body.results[0]).toEqual({ ok: true });
      expect(body.results[1]).toMatchObject({ error: expect.any(String) });
      expect(body.results[2]).toMatchObject({ error: 'key_invalid' });
      expect(body.results[3]).toEqual({ value: 'good' });
    });

    it('rejects ops array > 100 with 400', async () => {
      mockResolveOk('app_test');
      const ops = Array.from({ length: 101 }, (_, i) => ({ op: 'get', key: `k${i}` }));
      const res = await worker.fetch(req('POST', '/v1/app_test/kv/_batch', { ops }), env);
      expect(res.status).toBe(400);
    });

    it('returns 400 when ops is not an array', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('POST', '/v1/app_test/kv/_batch', { ops: 'nope' }), env);
      expect(res.status).toBe(400);
    });

    it('returns 405 for wrong method', async () => {
      mockResolveOk('app_test');
      const res = await worker.fetch(req('GET', '/v1/app_test/kv/_batch'), env);
      expect(res.status).toBe(405);
    });
  });
});
