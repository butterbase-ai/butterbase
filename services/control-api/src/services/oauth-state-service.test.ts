import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    auth: {
      jwtSecret: 'test-secret-for-oauth-state',
    },
  },
}));

import { OAuthStateService } from './oauth-state-service.js';

const payload = {
  client_id: 'mcp_abc',
  redirect_uri: 'http://127.0.0.1:1234/cb',
  scope: 'mcp',
  state: 'xyz',
  code_challenge: 'c'.repeat(43),
};

describe('OAuthStateService', () => {
  it('round-trips a signed payload', () => {
    const tok = OAuthStateService.sign(payload);
    const out = OAuthStateService.verify(tok);
    expect(out).not.toBeNull();
    expect(out!.client_id).toBe('mcp_abc');
    expect(out!.scope).toBe('mcp');
  });

  it('verify returns null for tampered tokens', () => {
    const tok = OAuthStateService.sign(payload);
    // Tamper near the start of the signature segment (third dot-separated part)
    // to avoid accidentally hitting a base64url padding character at the tail.
    const parts = tok.split('.');
    const sig = parts[2]!;
    const tampered = sig[0] === 'A' ? 'B' + sig.slice(1) : 'A' + sig.slice(1);
    const tamperedTok = [parts[0], parts[1], tampered].join('.');
    expect(OAuthStateService.verify(tamperedTok)).toBeNull();
  });

  it('verify returns null for garbage', () => {
    expect(OAuthStateService.verify('not-a-jwt')).toBeNull();
    expect(OAuthStateService.verify('a.b.c')).toBeNull();
  });
});
