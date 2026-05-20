import * as jose from 'jose';
import type { AuthProvider, UserClaims } from './auth-provider.js';

export class CognitoAuthProvider implements AuthProvider {
  private userPoolId: string;
  private clientId: string;
  private region: string;
  private jwksUri: string;
  private jwksCache: jose.JWTVerifyGetKey | null = null;

  constructor(userPoolId: string, clientId: string, region: string) {
    // Pool IDs are part of the JWKS URL path and can be mixed-case (e.g. <your-cognito-pool-id>).
    // Do not normalize casing here; it must match the actual pool id.
    this.userPoolId = userPoolId;
    this.clientId = clientId;
    this.region = region;
    this.jwksUri = `https://cognito-idp.${region}.amazonaws.com/${this.userPoolId}/.well-known/jwks.json`;
  }

  private async getJWKS(): Promise<jose.JWTVerifyGetKey> {
    if (!this.jwksCache) {
      this.jwksCache = jose.createRemoteJWKSet(new URL(this.jwksUri), {
        cooldownDuration: 30_000,
        timeoutDuration: 15_000,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Butterbase-Control-API/1.0',
        },
      });
    }
    return this.jwksCache;
  }

  async verifyJwt(token: string): Promise<UserClaims> {
    const expectedIssuer = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPoolId}`;
    try {
      const JWKS = await this.getJWKS();

      // Cognito access tokens do not include `aud`; they use `client_id`. ID tokens use `aud`.
      // Validate app binding after signature + issuer so either token type works for admin APIs.
      const { payload } = await jose.jwtVerify(token, JWKS, {
        issuer: expectedIssuer,
      });

      const tokenUse = payload.token_use as string | undefined;
      if (tokenUse === 'access') {
        if (payload.client_id !== this.clientId) {
          throw new Error('Cognito access token client_id mismatch');
        }
      } else if (tokenUse === 'id' || tokenUse === undefined) {
        const aud = payload.aud;
        const audOk =
          aud === this.clientId || (Array.isArray(aud) && aud.includes(this.clientId));
        if (!audOk) {
          throw new Error('Cognito id token aud mismatch');
        }
      } else {
        throw new Error(`Unsupported Cognito token_use: ${String(tokenUse)}`);
      }

      return {
        sub: payload.sub as string,
        email: (payload.email as string) ?? '',
        email_verified: Boolean(payload.email_verified),
      };
    } catch (error) {
      console.error('Cognito JWT verification failed:', error);
      console.error(
        `JWKS URL: ${this.jwksUri} — align COGNITO_USER_POOL_ID, COGNITO_REGION, COGNITO_CLIENT_ID with the app client that mints the token (same values as VITE_COGNITO_* on the admin dashboard build). Issuer expected: ${expectedIssuer}`
      );
      throw new Error('Invalid Cognito JWT token');
    }
  }
}
