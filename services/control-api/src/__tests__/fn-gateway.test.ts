import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { autoApiRoutes } from '../routes/auto-api.js';

// auto-api now calls assertRegionConfig() inside the fn gateway handler.
// Mock the config module so assertRegionConfig() returns a stable test region.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    assertRegionConfig: () => ({ instanceRegion: 'test-region', regions: ['test-region'] }),
  };
});

// Intercept all outbound fetch calls so tests never hit the real Deno runtime
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeDenoResponse(body = '{"ok":true}', status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fn gateway – header forwarding', () => {
  const app = Fastify();

  beforeAll(async () => {
    app.register(databasePlugin);
    // Stub runtimeDb: auto-api now queries apps via runtimeDb(region) for the paused kill-switch.
    app.decorate('runtimeDb', ((_region: string) => ({ query: async () => ({ rows: [] }) })) as any);
    app.register(autoApiRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  it('forwards custom X-* headers to the Deno runtime', async () => {
    mockFetch.mockResolvedValueOnce(makeDenoResponse());

    await app.inject({
      method: 'POST',
      url: '/v1/app_test001/fn/my-func',
      headers: {
        'x-fei-token': 'secret123',
        'x-webhook-signature': 'sha256=abc',
        'content-type': 'application/json',
      },
      payload: { hello: 'world' },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-fei-token']).toBe('secret123');
    expect(headers['x-webhook-signature']).toBe('sha256=abc');
  });

  it('always injects x-app-id and x-user-id platform headers', async () => {
    mockFetch.mockResolvedValueOnce(makeDenoResponse());

    await app.inject({
      method: 'POST',
      url: '/v1/app_test001/fn/my-func',
      payload: {},
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-app-id']).toBe('app_test001');
    expect(headers['x-user-id']).toBeDefined();
  });

  it('does NOT forward the host header', async () => {
    mockFetch.mockResolvedValueOnce(makeDenoResponse());

    await app.inject({
      method: 'POST',
      url: '/v1/app_test001/fn/my-func',
      headers: { host: 'evil.example.com' },
      payload: {},
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['host']).toBeUndefined();
  });
});

describe('fn gateway – body forwarding', () => {
  const app = Fastify();

  beforeAll(async () => {
    // Register the wildcard parser exactly as index.ts does
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });
    app.register(databasePlugin);
    // Stub runtimeDb: auto-api now queries apps via runtimeDb(region) for the paused kill-switch.
    app.decorate('runtimeDb', ((_region: string) => ({ query: async () => ({ rows: [] }) })) as any);
    app.register(autoApiRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  it('forwards JSON body without double-serialization', async () => {
    mockFetch.mockResolvedValueOnce(makeDenoResponse());

    await app.inject({
      method: 'POST',
      url: '/v1/app_test001/fn/my-func',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'alice' },
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = init.body as Buffer;
    expect(JSON.parse(body.toString())).toEqual({ name: 'alice' });
  });

  it('forwards text/plain body as raw bytes without JSON-encoding', async () => {
    mockFetch.mockResolvedValueOnce(makeDenoResponse());

    await app.inject({
      method: 'POST',
      url: '/v1/app_test001/fn/my-func',
      headers: { 'content-type': 'text/plain' },
      body: 'hello world',
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = init.body as Buffer;
    expect(body.toString()).toBe('hello world');
  });

  it('preserves original content-type header for text/plain', async () => {
    mockFetch.mockResolvedValueOnce(makeDenoResponse());

    await app.inject({
      method: 'POST',
      url: '/v1/app_test001/fn/my-func',
      headers: { 'content-type': 'text/plain' },
      body: 'ping',
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('text/plain');
  });

  it('forwards binary/octet-stream body without data loss', async () => {
    mockFetch.mockResolvedValueOnce(makeDenoResponse());
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff]);

    await app.inject({
      method: 'POST',
      url: '/v1/app_test001/fn/my-func',
      headers: { 'content-type': 'application/octet-stream' },
      body: binaryData,
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = init.body as Buffer;
    expect(Buffer.compare(body, binaryData)).toBe(0);
  });

  it('sends no body for GET requests', async () => {
    mockFetch.mockResolvedValueOnce(makeDenoResponse('[]'));

    await app.inject({
      method: 'GET',
      url: '/v1/app_test001/fn/my-func',
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });
});
