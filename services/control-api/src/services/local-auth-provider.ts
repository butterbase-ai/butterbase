import * as jose from 'jose';
import type { AuthProvider, UserClaims } from './auth-provider.js';

export class LocalAuthProvider implements AuthProvider {
  private secret: Uint8Array;

  constructor(jwtSecret: string) {
    this.secret = new TextEncoder().encode(jwtSecret);
  }

  async verifyJwt(token: string): Promise<UserClaims> {
    try {
      const { payload } = await jose.jwtVerify(token, this.secret);

      return {
        sub: payload.sub as string,
        email: payload.email as string,
        email_verified: payload.email_verified as boolean,
      };
    } catch (error) {
      throw new Error('Invalid JWT token');
    }
  }

  /**
   * Helper method to create dev tokens for testing
   */
  static async createDevToken(
    userId: string,
    email: string,
    jwtSecret: string
  ): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);

    return await new jose.SignJWT({
      sub: userId,
      email,
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(secret);
  }
}
