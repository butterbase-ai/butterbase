import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OAuthClientService } from './oauth-client-service.js';

function makePoolStub(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as any;
}

describe('OAuthClientService', () => {
  it('issues a client_id with the mcp_ prefix and stores redirect_uris', async () => {
    const redirectUris = ['http://127.0.0.1:44321/callback'];
    const pool = makePoolStub([
      {
        client_id: 'mcp_aabbccddeeff00112233aabb',
        client_name: 'Claude Code',
        redirect_uris: redirectUris,
        created_at: new Date(),
      },
    ]);

    const result = await OAuthClientService.register(pool, {
      client_name: 'Claude Code',
      redirect_uris: redirectUris,
    });

    expect(result.client_id).toMatch(/^mcp_[0-9a-f]{24}$/);
    expect(result.redirect_uris).toEqual(redirectUris);

    // Verify the SQL args sent to pool.query
    const [sql, args] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO oauth_clients/i);
    expect(args[0]).toMatch(/^mcp_[0-9a-f]{24}$/); // generated client_id
    expect(args[1]).toBe('Claude Code');
    expect(args[2]).toEqual(redirectUris);
  });

  it('rejects more than 5 redirect_uris', async () => {
    const pool = makePoolStub();
    await expect(
      OAuthClientService.register(pool, {
        redirect_uris: Array.from({ length: 6 }, (_, i) => `https://x.example/${i}`),
      })
    ).rejects.toThrow(/at most 5/i);
  });

  it('rejects http redirect_uris that are not loopback', async () => {
    const pool = makePoolStub();
    await expect(
      OAuthClientService.register(pool, {
        redirect_uris: ['http://evil.example/cb'],
      })
    ).rejects.toThrow(/loopback/i);
  });

  it('accepts http://localhost and http://127.0.0.1', async () => {
    const localhostRow = {
      client_id: 'mcp_aabbccddeeff00112233aa01',
      client_name: null,
      redirect_uris: ['http://localhost:1234/cb'],
      created_at: new Date(),
    };
    const loopbackRow = {
      client_id: 'mcp_aabbccddeeff00112233aa02',
      client_name: null,
      redirect_uris: ['http://127.0.0.1:5678/cb'],
      created_at: new Date(),
    };

    const poolA = makePoolStub([localhostRow]);
    const poolB = makePoolStub([loopbackRow]);

    // Neither call should throw
    await expect(
      OAuthClientService.register(poolA, { redirect_uris: ['http://localhost:1234/cb'] })
    ).resolves.toBeDefined();
    await expect(
      OAuthClientService.register(poolB, { redirect_uris: ['http://127.0.0.1:5678/cb'] })
    ).resolves.toBeDefined();
  });

  it('lookup returns null for unknown client_id', async () => {
    const pool = makePoolStub([]);
    expect(await OAuthClientService.lookup(pool, 'mcp_doesnotexist')).toBeNull();
  });
});
