import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createButterbaseMcpServer } from '../create-server.js';

async function createConnectedPair() {
  const server = createButterbaseMcpServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client };
}

describe('manage_kv tool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('set action forwards a PUT request to the correct URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    const out = await client.callTool({
      name: 'manage_kv',
      arguments: { app_id: 'app_test123', action: 'set', key: 'mykey', value: 'myval' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Must be /v1/<app>/kv/<key> — NOT /kv/data/<key>
    expect(url).toMatch(/\/v1\/app_test123\/kv\/mykey$/);
    expect(url).not.toContain('/kv/data/');
    expect(opts.method).toBe('PUT');
    const body = JSON.parse(opts.body as string);
    expect(body.value).toBe('myval');

    const text = (out.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    expect(text).toContain('ok');
  });

  it('get action forwards a GET request to the correct URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ value: 'hello' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    const out = await client.callTool({
      name: 'manage_kv',
      arguments: { app_id: 'app_test123', action: 'get', key: 'mykey' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Must be /v1/<app>/kv/<key> — NOT /kv/data/<key>
    expect(url).toMatch(/\/v1\/app_test123\/kv\/mykey$/);
    expect(url).not.toContain('/kv/data/');
    expect(opts.method).toBeUndefined(); // GET is the default (no method set)

    const text = (out.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    expect(text).toContain('hello');
  });

  it('flush returns an error when confirm is not true', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    const out = await client.callTool({
      name: 'manage_kv',
      arguments: { app_id: 'app_test123', action: 'flush' },
    });

    // fetch should NOT have been called — validation error before network
    expect(fetchMock).not.toHaveBeenCalled();

    const text = (out.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    expect(text).toContain('Error');
    expect(text).toContain('confirm');
  });

  it('expose uses PUT to /_expose/<urlencoded-pattern> with read/write body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    await client.callTool({
      name: 'manage_kv',
      arguments: {
        app_id: 'app_test123',
        action: 'expose',
        pattern: 'user:*',
        read: 'authed',
        write: 'owner',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Must use /_expose/<encoded-pattern>
    expect(url).toContain('/_expose/');
    expect(url).toContain('user%3A');
    expect(opts.method).toBe('PUT');
    const body = JSON.parse(opts.body as string);
    expect(body.read).toBe('authed');
    expect(body.write).toBe('owner');
  });

  it('scan uses GET /_scan with prefix and limit query params (NOT pattern/count)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [], cursor: null }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    await client.callTool({
      name: 'manage_kv',
      arguments: {
        app_id: 'app_test123',
        action: 'scan',
        prefix: 'user:',
        limit: 50,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/_scan');
    expect(url).toContain('prefix=user%3A');
    expect(url).toContain('limit=50');
    // Must NOT use old wrong param names
    expect(url).not.toContain('pattern=');
    expect(url).not.toContain('count=');
  });

  it('unexpose URL-encodes the pattern when deleting the rule', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    await client.callTool({
      name: 'manage_kv',
      arguments: { app_id: 'app_test123', action: 'unexpose', pattern: 'user:*' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Must use /_expose/<encoded-pattern>
    expect(url).toContain('/_expose/');
    expect(url).toContain('user%3A');
  });
});
