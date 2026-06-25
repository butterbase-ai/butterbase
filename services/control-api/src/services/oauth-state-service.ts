import { createHmac, timingSafeEqual } from 'node:crypto';
import * as jose from 'jose';
import { config } from '../config.js';

export interface AuthorizePayload {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
}

const TTL_SECONDS = 600;

export class OAuthStateService {
  static sign(payload: AuthorizePayload): string {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + TTL_SECONDS;

    const header = jose.base64url.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = jose.base64url.encode(JSON.stringify({ ...payload, iat, exp }));
    const signingInput = `${header}.${body}`;

    const sig = createHmac('sha256', config.auth.jwtSecret)
      .update(signingInput)
      .digest('base64url');

    return `${signingInput}.${sig}`;
  }

  static verify(token: string): (AuthorizePayload & { iat: number; exp: number }) | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const [header, body, sig] = parts as [string, string, string];
      const signingInput = `${header}.${body}`;

      const expected = createHmac('sha256', config.auth.jwtSecret)
        .update(signingInput)
        .digest('base64url');

      // Constant-time comparison
      const sigBuf = Buffer.from(sig);
      const expectedBuf = Buffer.from(expected);
      if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

      const claims = JSON.parse(
        new TextDecoder().decode(jose.base64url.decode(body)),
      ) as AuthorizePayload & { iat: number; exp: number };

      const now = Math.floor(Date.now() / 1000);
      if (claims.exp < now) return null;

      return claims;
    } catch {
      return null;
    }
  }
}
