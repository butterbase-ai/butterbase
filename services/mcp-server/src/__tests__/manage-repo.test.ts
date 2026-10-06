import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createButterbaseMcpServer } from '../create-server.js';

async function createConnectedPair() {
  const server = await createButterbaseMcpServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client };
}

describe('manage_repo tool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pull_snapshot fetches the specific snapshot and hydrates blob download URLs', async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const s = String(url);
      if (s.includes('/repo/snapshots/snap_old')) {
        return new Response(JSON.stringify({
          snapshot_id: 'snap_old',
          manifest: {
            files: [
              { path: 'src/App.tsx', sha256: 'a'.repeat(64), size: 10 },
              { path: 'package.json', sha256: 'b'.repeat(64), size: 5 },
            ],
          },
        }), { status: 200 });
      }
      if (s.includes('/repo/blobs/batch')) {
        return new Response(JSON.stringify({
          blobs: [
            { sha256: 'a'.repeat(64), size: 10, downloadUrl: 'https://s3/a' },
            { sha256: 'b'.repeat(64), size: 5, downloadUrl: 'https://s3/b' },
          ],
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${s}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    const out = await client.callTool({
      name: 'manage_repo',
      arguments: { app_id: 'app_test123', action: 'pull_snapshot', snapshot_id: 'snap_old' },
    });

    // First call must be the specific-snapshot GET, URL-encoded snapshot_id.
    const [firstUrl] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstUrl).toContain('/v1/app_test123/repo/snapshots/snap_old');

    const text = (out.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    const parsed = JSON.parse(text);
    expect(parsed.snapshot_id).toBe('snap_old');
    expect(parsed.files).toEqual([
      { path: 'src/App.tsx', sha256: 'a'.repeat(64), size: 10, downloadUrl: 'https://s3/a' },
      { path: 'package.json', sha256: 'b'.repeat(64), size: 5, downloadUrl: 'https://s3/b' },
    ]);
  });

  it('pull_snapshot returns an error when snapshot_id is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { client } = await createConnectedPair();
    const out = await client.callTool({
      name: 'manage_repo',
      arguments: { app_id: 'app_test123', action: 'pull_snapshot' },
    });

    expect(fetchMock).not.toHaveBeenCalled();

    const text = (out.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n');
    expect(text).toContain('Error');
    expect(text).toContain('snapshot_id');
  });
});
