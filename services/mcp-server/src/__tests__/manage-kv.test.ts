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
    expect(url).toContain('/v1/internal/kv/proxy/app_test123/kv/data/mykey');
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
    expect(url).toContain('/v1/internal/kv/proxy/app_test123/kv/data/mykey');
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

  it('expose URL-encodes the pattern when calling unexpose', async () => {
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
    // 'user:*' should be URL-encoded as 'user%3A*' or similar
    expect(url).toContain('user%3A');
  });
});
