import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import authPlugin from '../plugins/auth.js';
import { initRoutes } from '../routes/init.js';
import { LocalAuthProvider } from '../services/local-auth-provider.js';
import { config } from '../config.js';

describe('Auth Provider', () => {
  describe('LocalAuthProvider', () => {
    const jwtSecret = 'test-secret';
    const provider = new LocalAuthProvider(jwtSecret);

    it('creates and verifies valid token', async () => {
      const userId = 'test-user-123';
      const email = 'test@example.com';

      const token = await LocalAuthProvider.createDevToken(userId, email, jwtSecret);
      const claims = await provider.verifyJwt(token);

      expect(claims.sub).toBe(userId);
      expect(claims.email).toBe(email);
      expect(claims.email_verified).toBe(true);
    });

    it('rejects malformed token', async () => {
      await expect(provider.verifyJwt('invalid-token')).rejects.toThrow('Invalid JWT token');
    });

    it('rejects token with wrong secret', async () => {
      const token = await LocalAuthProvider.createDevToken('user', 'test@example.com', 'wrong-secret');
      await expect(provider.verifyJwt(token)).rejects.toThrow('Invalid JWT token');
    });
  });

  describe('Auth Plugin JWT Routing', () => {
    const app = Fastify();
    let testUserId: string;
    let jwtToken: string;

    beforeAll(async () => {
      process.env.AUTH_ENABLED = 'true';

      app.register(databasePlugin);
      app.register(dataPlanePlugin);
      app.register(authPlugin);
      app.register(initRoutes);
      await app.ready();

      // Create test user
      const userResult = await app.controlDb.query(
        `INSERT INTO platform_users (email, cognito_sub)
         VALUES ('jwt-test@example.com', 'jwt-test-sub')
         RETURNING id`
      );
      testUserId = userResult.rows[0].id;

      // Create JWT token
      jwtToken = await LocalAuthProvider.createDevToken(
        'jwt-test-sub',
        'jwt-test@example.com',
        config.auth.jwtSecret
      );
    });

    afterAll(async () => {
      await app.controlDb.query('DELETE FROM platform_users WHERE id = $1', [testUserId]);
      await app.close();
      delete process.env.AUTH_ENABLED;
    });

    it('accepts valid JWT token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/apps',
        headers: {
          'Authorization': `Bearer ${jwtToken}`
        }
      });

      expect(response.statusCode).toBe(200);
    });

    it('creates user on first JWT validation', async () => {
      const newJwtToken = await LocalAuthProvider.createDevToken(
        'new-user-sub',
        'newuser@example.com',
        config.auth.jwtSecret
      );

      const response = await app.inject({
        method: 'GET',
        url: '/apps',
        headers: {
          'Authorization': `Bearer ${newJwtToken}`
        }
      });

      expect(response.statusCode).toBe(200);

      // Verify user was created
      const result = await app.controlDb.query(
        'SELECT * FROM platform_users WHERE cognito_sub = $1',
        ['new-user-sub']
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].email).toBe('newuser@example.com');

      // Cleanup
      await app.controlDb.query(
        'DELETE FROM platform_users WHERE cognito_sub = $1',
        ['new-user-sub']
      );
    });

    it('rejects invalid JWT token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/apps',
        headers: {
          'Authorization': 'Bearer invalid.jwt.token'
        }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toContain('Invalid JWT token');
    });

    it('routes API keys correctly (not as JWT)', async () => {
      // This should be handled by API key validation, not JWT
      const response = await app.inject({
        method: 'GET',
        url: '/apps',
        headers: {
          'Authorization': 'Bearer bb_sk_test1234567890123456789012345678'
        }
      });

      // Should fail as invalid API key, not as invalid JWT
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toContain('Invalid or revoked API key');
    });
  });
});
