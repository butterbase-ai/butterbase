import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ButterbaseClient } from './butterbase-client';

describe('ButterbaseClient.requestStream', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('returns the response body as a ReadableStream when ok', async () => {
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('event: done\ndata: ok\n\n')); c.close(); },
    }), { status: 200 })) as any;
    const c = new ButterbaseClient({ apiUrl: 'https://x', appId: 'app', anonKey: 'k', persistSession: false });
    const stream = await c.requestStream('GET', '/v1/app/x/logs');
    expect(stream).toBeInstanceOf(ReadableStream);
  });

  it('throws on non-2xx', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'RESOURCE_NOT_FOUND', message: 'missing' } }), { status: 404, headers: { 'content-type': 'application/json' } })) as any;
    const c = new ButterbaseClient({ apiUrl: 'https://x', appId: 'app', anonKey: 'k', persistSession: false });
    await expect(c.requestStream('GET', '/v1/app/x/logs')).rejects.toThrow();
  });
});
