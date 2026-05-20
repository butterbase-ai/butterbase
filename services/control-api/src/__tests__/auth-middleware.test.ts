import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import authPlugin from '../plugins/auth.js';
import { healthRoutes } from '../routes/health.js';
import { initRoutes } from '../routes/init.js';
import { ApiKeyService } from '../services/api-key-service.js';

describe('Auth Middleware', () => {
  const app = Fastify();
  let testUserId: string;
  let validApiKey: string;
  let revokedApiKey: string;

  beforeAll(async () => {
    // Set AUTH_ENABLED to true for these tests
    process.env.AUTH_ENABLED = 'true';

    app.register(databasePlugin);
    app.register(dataPlanePlugin);
    app.register(authPlugin);
    app.register(healthRoutes);
    app.register(initRoutes);
    await app.ready();

    // Create test user
    const userResult = await app.controlDb.query(
      `INSERT INTO platform_users (email, cognito_sub)
       VALUES ('auth-test@example.com', 'auth-test-sub')
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // Generate valid API key
    const { key: validKey } = await ApiKeyService.generateApiKey(
      app.controlDb,
      testUserId,
      'Valid Key'
    );
    validApiKey = validKey;

    // Generate and revoke another key
    const { key: revokedKey, keyId } = await ApiKeyService.generateApiKey(
      app.controlDb,
      testUserId,
      'Revoked Key'
    );
    revokedApiKey = revokedKey;
    await ApiKeyService.revokeKey(app.controlDb, keyId, testUserId);
  });

  afterAll(async () => {
    await app.controlDb.query('DELETE FROM platform_users WHERE id = $1', [testUserId]);
    await app.close();
    delete process.env.AUTH_ENABLED;
  });

  it('returns 401 when no auth header provided', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/apps'
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toHaveProperty('error');
  });

  it('returns 401 for invalid API key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/apps',
      headers: {
        'Authorization': 'Bearer bb_sk_invalid1234567890123456789012345678'
      }
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 200 for valid API key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/apps',
      headers: {
        'Authorization': `Bearer ${validApiKey}`
      }
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns 401 for revoked API key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/apps',
      headers: {
        'Authorization': `Bearer ${revokedApiKey}`
      }
    });

    expect(response.statusCode).toBe(401);
  });

  it('allows public routes without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('status');
  });

  it('returns 401 for malformed Authorization header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/apps',
      headers: {
        'Authorization': 'InvalidFormat'
      }
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 401 for JWT tokens (not yet implemented)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/apps',
      headers: {
        'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test'
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toContain('JWT authentication not yet implemented');
  });
});
