import { describe, it, expect, vi } from 'vitest';
import { makeKv } from './kv.js';
import { KvKeyInvalidError } from './errors/kv.js';

function mkFetch(map: Record<string, { status: number; body?: string }>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${String(url)}`;
    const r = map[key];
    if (!r) return new Response('', { status: 500 });
    return new Response(r.body ?? null, { status: r.status });
  });
}

describe('ctx.kv (shim)', () => {
  it('get returns parsed value', async () => {
    const f = mkFetch({ 'GET https://kv.butterbase.dev/v1/app_a/kv/foo': { status: 200, body: JSON.stringify({ value: { x: 1 } }) } });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: 'https://kv.butterbase.dev', fetch: f as any });
    expect(await kv.get('foo')).toEqual({ x: 1 });
  });

  it('get returns null on 404', async () => {
    const f = mkFetch({ 'GET https://kv.butterbase.dev/v1/app_a/kv/missing': { status: 404 } });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: 'https://kv.butterbase.dev', fetch: f as any });
    expect(await kv.get('missing')).toBeNull();
  });

  it('set issues PUT with value body', async () => {
    let captured: any;
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(null, { status: 204 });
    });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: 'https://kv.butterbase.dev', fetch: f as any });
    await kv.set('foo', { x: 1 });
    expect(captured.url).toBe('https://kv.butterbase.dev/v1/app_a/kv/foo');
    expect(captured.init.method).toBe('PUT');
    expect(JSON.parse(captured.init.body)).toEqual({ value: { x: 1 } });
  });

  it('del returns 1 for 204, 0 for 404', async () => {
    const f = mkFetch({
      'DELETE https://kv.butterbase.dev/v1/app_a/kv/foo': { status: 204 },
      'DELETE https://kv.butterbase.dev/v1/app_a/kv/missing': { status: 404 },
    });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: 'https://kv.butterbase.dev', fetch: f as any });
    expect(await kv.del('foo')).toBe(1);
    expect(await kv.del('missing')).toBe(0);
  });

  it('get with touch:true appends ?touch=true to the URL', async () => {
    let capturedUrl: string | undefined;
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ value: 'hit' }), { status: 200 });
    });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: 'https://kv.butterbase.dev', fetch: f as any });
    const result = await kv.get('mykey', { touch: true });
    expect(result).toBe('hit');
    expect(capturedUrl).toBe('https://kv.butterbase.dev/v1/app_a/kv/mykey?touch=true');
  });

  it('get without touch option does not append ?touch=true', async () => {
    let capturedUrl: string | undefined;
    const f = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ value: 'hit' }), { status: 200 });
    });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: 'https://kv.butterbase.dev', fetch: f as any });
    await kv.get('mykey');
    expect(capturedUrl).toBe('https://kv.butterbase.dev/v1/app_a/kv/mykey');
  });

  it('throws KvKeyInvalidError on 400', async () => {
    const f = mkFetch({ 'GET https://kv.butterbase.dev/v1/app_a/kv/bad': { status: 400, body: JSON.stringify({ error: 'KV_KEY_INVALID', message: 'bad' }) } });
    const kv = makeKv({ appId: 'app_a', apiKey: 'k', baseUrl: 'https://kv.butterbase.dev', fetch: f as any });
    await expect(kv.get('bad')).rejects.toThrow(/bad/);
    await expect(kv.get('bad')).rejects.toBeInstanceOf(KvKeyInvalidError);
  });
});
