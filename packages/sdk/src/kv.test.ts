import { describe, it, expect, vi } from 'vitest';
import { makeKv } from './kv.js';
import { KvKeyInvalidError, KvCasMismatchError, KvValueTooLargeError } from './errors/kv.js';

const BASE = 'https://kv.butterbase.dev';
const ROOT = `${BASE}/v1/app_a/kv`;

function mkFetch(map: Record<string, { status: number; body?: string }>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${String(url)}`;
    const r = map[key];
    if (!r) return new Response('', { status: 500 });
    return new Response(r.body ?? null, { status: r.status });
  });
}

/** Returns a fetch mock that always responds with (status, body) and captures the last call. */
function makeSpy(status: number, body?: unknown) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const rawBody = init?.body;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined,
    });
    return new Response(body !== undefined ? JSON.stringify(body) : null, { status });
  });
  const last = () => calls[calls.length - 1]!;
  return { f, calls, last };
}

describe('ctx.kv (shim)', () => {
  // ─── existing tests ────────────────────────────────────────────────────────

  it('get returns parsed value', async () => {
    const f = mkFetch({ [`GET ${ROOT}/foo`]: { status: 200, body: JSON.stringify({ value: { x: 1 } }) } });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    expect(await kv.get('foo')).toEqual({ x: 1 });
  });

  it('get returns null on 404', async () => {
    const f = mkFetch({ [`GET ${ROOT}/missing`]: { status: 404 } });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    expect(await kv.get('missing')).toBeNull();
  });

  it('set issues PUT with value body', async () => {
    const { f, last } = makeSpy(204);
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    await kv.set('foo', { x: 1 });
    expect(last().url).toBe(`${ROOT}/foo`);
    expect(last().method).toBe('PUT');
    expect(last().body).toEqual({ value: { x: 1 } });
  });

  it('del returns 1 for 204, 0 for 404', async () => {
    const f = mkFetch({
      [`DELETE ${ROOT}/foo`]: { status: 204 },
      [`DELETE ${ROOT}/missing`]: { status: 404 },
    });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    expect(await kv.del('foo')).toBe(1);
    expect(await kv.del('missing')).toBe(0);
  });

  it('get with touch:true appends ?touch=true to the URL', async () => {
    let capturedUrl: string | undefined;
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ value: 'hit' }), { status: 200 });
    });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    const result = await kv.get('mykey', { touch: true });
    expect(result).toBe('hit');
    expect(capturedUrl).toBe(`${ROOT}/mykey?touch=true`);
  });

  it('get without touch option does not append ?touch=true', async () => {
    let capturedUrl: string | undefined;
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ value: 'hit' }), { status: 200 });
    });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    await kv.get('mykey');
    expect(capturedUrl).toBe(`${ROOT}/mykey`);
  });

  it('throws KvKeyInvalidError on 400', async () => {
    const f = mkFetch({ [`GET ${ROOT}/bad`]: { status: 400, body: JSON.stringify({ error: 'KV_KEY_INVALID', message: 'bad' }) } });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    await expect(kv.get('bad')).rejects.toThrow(/bad/);
    await expect(kv.get('bad')).rejects.toBeInstanceOf(KvKeyInvalidError);
  });

  // ─── set with options ──────────────────────────────────────────────────────

  it('set with ttl forwards ttl in body', async () => {
    const { f, last } = makeSpy(204);
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    await kv.set('k', 1, { ttl: 60 });
    expect(last().url).toBe(`${ROOT}/k`);
    expect(last().method).toBe('PUT');
    expect(last().body).toEqual({ value: 1, ttl: 60 });
  });

  it('set with ephemeral forwards ephemeral in body', async () => {
    const { f, last } = makeSpy(204);
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    await kv.set('k', 1, { ephemeral: true });
    expect(last().body).toEqual({ value: 1, ephemeral: true });
  });

  // ─── setex ────────────────────────────────────────────────────────────────

  it('setex issues PUT with value and ttl', async () => {
    const { f, last } = makeSpy(204);
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    await kv.setex('k', 1, 60);
    expect(last().url).toBe(`${ROOT}/k`);
    expect(last().method).toBe('PUT');
    expect(last().body).toEqual({ value: 1, ttl: 60 });
  });

  // ─── incr / decr ──────────────────────────────────────────────────────────

  it('incr without by sends empty body and returns value', async () => {
    const { f, last } = makeSpy(200, { value: 1 });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    const result = await kv.incr('k');
    expect(last().url).toBe(`${ROOT}/k/incr`);
    expect(last().method).toBe('POST');
    expect(last().body).toEqual({});
    expect(result).toBe(1);
  });

  it('incr with by sends {by} in body', async () => {
    const { f, last } = makeSpy(200, { value: 5 });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    const result = await kv.incr('k', 5);
    expect(last().body).toEqual({ by: 5 });
    expect(result).toBe(5);
  });

  it('decr with by sends {by} in body', async () => {
    const { f, last } = makeSpy(200, { value: -3 });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    const result = await kv.decr('k', 3);
    expect(last().url).toBe(`${ROOT}/k/decr`);
    expect(last().body).toEqual({ by: 3 });
    expect(result).toBe(-3);
  });

  // ─── setnx ────────────────────────────────────────────────────────────────

  it('setnx returns true on 201', async () => {
    const { f, last } = makeSpy(201, { wrote: true });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    const wrote = await kv.setnx('k', 1);
    expect(last().url).toBe(`${ROOT}/k/setnx`);
    expect(last().method).toBe('POST');
    expect(wrote).toBe(true);
  });

  it('setnx returns false on 200', async () => {
    const { f } = makeSpy(200, { wrote: false });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    expect(await kv.setnx('k', 1)).toBe(false);
  });

  // ─── cas ──────────────────────────────────────────────────────────────────

  it('cas posts expected/next and returns swapped', async () => {
    const { f, last } = makeSpy(200, { swapped: true });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    const swapped = await kv.cas('k', 'a', 'b');
    expect(last().url).toBe(`${ROOT}/k/cas`);
    expect(last().method).toBe('POST');
    expect(last().body).toEqual({ expected: 'a', next: 'b' });
    expect(swapped).toBe(true);
  });

  it('cas returns false when swapped is false', async () => {
    const { f } = makeSpy(200, { swapped: false });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    expect(await kv.cas('k', 'a', 'b')).toBe(false);
  });

  // ─── exists ───────────────────────────────────────────────────────────────

  it('exists returns boolean from {exists}', async () => {
    const { f, last } = makeSpy(200, { exists: true });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    const result = await kv.exists('k');
    expect(last().url).toBe(`${ROOT}/k/exists`);
    expect(result).toBe(true);
  });

  // ─── ttl ──────────────────────────────────────────────────────────────────

  it('ttl returns number from {ttl}', async () => {
    const { f, last } = makeSpy(200, { ttl: 120 });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    const result = await kv.ttl('k');
    expect(last().url).toBe(`${ROOT}/k/ttl`);
    expect(result).toBe(120);
  });

  it('ttl returns null on 404', async () => {
    const { f } = makeSpy(404);
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    expect(await kv.ttl('k')).toBeNull();
  });

  // ─── expire ───────────────────────────────────────────────────────────────

  it('expire posts {ttl:null} and returns ok', async () => {
    const { f, last } = makeSpy(200, { ok: true });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    const result = await kv.expire('k', null);
    expect(last().url).toBe(`${ROOT}/k/expire`);
    expect(last().method).toBe('POST');
    expect(last().body).toEqual({ ttl: null });
    expect(result).toBe(true);
  });

  // ─── mget ─────────────────────────────────────────────────────────────────

  it('mget sends one batch POST and maps results', async () => {
    const batchResponse = {
      results: [
        { value: 'hello' },
        { error: 'not_found' },
      ],
    };
    const { f, last } = makeSpy(200, batchResponse);
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    const results = await kv.mget(['a', 'b']);
    expect(last().url).toBe(`${ROOT}/_batch`);
    expect(last().method).toBe('POST');
    expect(last().body).toEqual({
      ops: [{ op: 'get', key: 'a' }, { op: 'get', key: 'b' }],
    });
    expect(results).toEqual(['hello', null]);
    // Only one fetch call was made (not two)
    expect(f).toHaveBeenCalledTimes(1);
  });

  // ─── mset ─────────────────────────────────────────────────────────────────

  it('mset issues parallel PUTs for each entry', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body as string) });
      return new Response(null, { status: 204 });
    });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    await kv.mset({ a: 1, b: 2 });
    expect(f).toHaveBeenCalledTimes(2);
    const urlA = calls.find((c) => c.url === `${ROOT}/a`);
    const urlB = calls.find((c) => c.url === `${ROOT}/b`);
    expect(urlA?.body).toEqual({ value: 1 });
    expect(urlB?.body).toEqual({ value: 2 });
  });

  // ─── new error classes ────────────────────────────────────────────────────

  it('throws KvValueTooLargeError on 413', async () => {
    const f = mkFetch({
      [`PUT ${ROOT}/big`]: { status: 413, body: JSON.stringify({ error: 'KV_VALUE_TOO_LARGE', message: 'value too large' }) },
    });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    await expect(kv.set('big', 'x')).rejects.toBeInstanceOf(KvValueTooLargeError);
  });

  it('throws KvCasMismatchError on 409', async () => {
    const f = mkFetch({
      [`POST ${ROOT}/k/cas`]: { status: 409, body: JSON.stringify({ error: 'KV_CAS_MISMATCH', message: 'cas mismatch' }) },
    });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: BASE, fetch: f as any });
    await expect(kv.cas('k', 'a', 'b')).rejects.toBeInstanceOf(KvCasMismatchError);
  });
});
