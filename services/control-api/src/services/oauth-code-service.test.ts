import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { OAuthCodeService } from './oauth-code-service.js';
import type { RequestedTarget } from './oauth-code-service.js';

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('OAuthCodeService', () => {
  it('issues a base64url code with 60s TTL', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    const { challenge } = pkce();
    const before = Date.now();

    const result = await OAuthCodeService.issue(pool, {
      client_id: 'mcp_client1',
      user_id: 'u1',
      redirect_uri: 'http://127.0.0.1:44321/cb',
      scope: 'mcp',
      code_challenge: challenge,
      requested_target: { key_scope: 'account', additional_scopes: [] },
    });

    // Code shape: 32 bytes base64url → 43 chars
    expect(result.code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // TTL: expires_at should be ~60s from now
    const diff = result.expires_at.getTime() - before;
    expect(diff).toBeGreaterThan(55_000);
    expect(diff).toBeLessThan(61_000);

    // Verify SQL args: code_hash, client_id, user_id, redirect_uri, scope, code_challenge, requested_target, expires_at
    const [sql, args] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO oauth_authorization_codes/i);
    // args[0] is the code_hash (sha256 hex of the code)
    const expectedHash = crypto.createHash('sha256').update(result.code).digest('hex');
    expect(args[0]).toBe(expectedHash);
    expect(args[1]).toBe('mcp_client1');   // client_id
    expect(args[2]).toBe('u1');            // user_id
    expect(args[3]).toBe('http://127.0.0.1:44321/cb'); // redirect_uri
    expect(args[4]).toBe('mcp');           // scope
    expect(args[5]).toBe(challenge);       // code_challenge
    expect(args[6]).toEqual({ key_scope: 'account', additional_scopes: [] }); // requested_target
    expect(args[7]).toEqual(result.expires_at); // expires_at
  });

  it('consume() succeeds with matching verifier', async () => {
    const { verifier, challenge } = pkce();
    const target: RequestedTarget = { key_scope: 'app', target_app_id: 'app_demo', additional_scopes: ['ai:gateway'] };
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ user_id: 'u1', scope: 'mcp', code_challenge: challenge, requested_target: target }],
      }),
    } as any;

    const fakeCode = crypto.randomBytes(32).toString('base64url');
    const out = await OAuthCodeService.consume(pool, {
      code: fakeCode,
      client_id: 'mcp_client1',
      redirect_uri: 'http://127.0.0.1:44321/cb',
      code_verifier: verifier,
    });

    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.user_id).toBe('u1');
    expect(out.scope).toBe('mcp');
    expect(out.requested_target).toEqual(target);
  });

  it('consume() with wrong verifier returns invalid_grant', async () => {
    const { challenge } = pkce();
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ user_id: 'u1', scope: 'mcp', code_challenge: challenge, requested_target: { key_scope: 'account', additional_scopes: [] } }],
      }),
    } as any;

    const fakeCode = crypto.randomBytes(32).toString('base64url');
    const out = await OAuthCodeService.consume(pool, {
      code: fakeCode,
      client_id: 'mcp_client1',
      redirect_uri: 'http://127.0.0.1:44321/cb',
      code_verifier: 'wrong-verifier',
    });

    expect(out).toEqual({ error: 'invalid_grant' });
  });

  it('consume() is single-use', async () => {
    const { verifier, challenge } = pkce();
    const target: RequestedTarget = { key_scope: 'account', additional_scopes: [] };
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ user_id: 'u1', scope: 'mcp', code_challenge: challenge, requested_target: target }] })
        .mockResolvedValue({ rows: [] }),
    } as any;

    const fakeCode = crypto.randomBytes(32).toString('base64url');
    const first = await OAuthCodeService.consume(pool, {
      code: fakeCode,
      client_id: 'mcp_client1',
      redirect_uri: 'http://127.0.0.1:44321/cb',
      code_verifier: verifier,
    });
    expect('error' in first).toBe(false);

    const second = await OAuthCodeService.consume(pool, {
      code: fakeCode,
      client_id: 'mcp_client1',
      redirect_uri: 'http://127.0.0.1:44321/cb',
      code_verifier: verifier,
    });
    expect(second).toEqual({ error: 'invalid_grant' });
  });

  it('consume() with mismatched redirect_uri returns invalid_grant', async () => {
    // DB returns empty rows because redirect_uri doesn't match in the WHERE clause
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;

    const { verifier } = pkce();
    const fakeCode = crypto.randomBytes(32).toString('base64url');
    const out = await OAuthCodeService.consume(pool, {
      code: fakeCode,
      client_id: 'mcp_client1',
      redirect_uri: 'http://127.0.0.1:99999/cb',
      code_verifier: verifier,
    });

    expect(out).toEqual({ error: 'invalid_grant' });
  });
});
