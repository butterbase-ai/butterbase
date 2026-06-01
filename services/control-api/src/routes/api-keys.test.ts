import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import authPlugin from '../plugins/auth.js';
import { initRoutes } from './init.js';
import { apiKeyRoutes } from './api-keys.js';
import { ApiKeyService } from '../services/api-key-service.js';

describe('API Key Routes', () => {
  const app = Fastify();
  let testUserId: string;
  let platformSessionToken: string;

  beforeAll(async () => {
    process.env.AUTH_ENABLED = 'true';

    app.register(databasePlugin);
    app.register(dataPlanePlugin);
    app.register(authPlugin);
    app.register(initRoutes);
    app.register(apiKeyRoutes);
    await app.ready();

    // Create a test platform user
    const userResult = await app.controlDb.query(
      `INSERT INTO platform_users (email, cognito_sub)
       VALUES ('api-keys-test@example.com', 'api-keys-test-sub')
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // Generate a valid API key for this user (used as the Bearer token)
    const { key } = await ApiKeyService.generateApiKey(
      app.controlDb,
      testUserId,
      'API Keys Test Session Key'
    );
    platformSessionToken = key;
  });

  afterAll(async () => {
    // Clean up api keys owned by test user
    await app.controlDb.query(
      'DELETE FROM api_keys WHERE user_id = $1',
      [testUserId]
    );
    // Clean up test user
    await app.controlDb.query(
      'DELETE FROM platform_users WHERE id = $1',
      [testUserId]
    );
    await app.close();
    delete process.env.AUTH_ENABLED;
  });

  it("POST /api-keys with scope='both' returns 201 and stores scope='both'", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { Authorization: `Bearer ${platformSessionToken}` },
      payload: { name: 'combo', scope: 'both' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key.startsWith('bb_sk_')).toBe(true);

    const row = (
      await app.controlDb.query(
        'SELECT scope FROM api_keys WHERE id = $1',
        [body.keyId]
      )
    ).rows[0];
    expect(row.scope).toBe('both');
  });

  it("POST /api-keys with invalid scope returns 400", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { Authorization: `Bearer ${platformSessionToken}` },
      payload: { name: 'bad', scope: 'admin' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_INVALID_SCOPE');
  });
});
