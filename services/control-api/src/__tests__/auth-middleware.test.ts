import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import authPlugin from '../plugins/auth.js';
import { healthRoutes } from '../routes/health.js';
import { initRoutes } from '../routes/init.js';
import { randomUUID } from 'node:crypto';
import { LocalAuthProvider } from '../services/local-auth-provider.js';
import { config } from '../config.js';
import { ApiKeyService, mintOrganizationLockedApiKeyInTransaction } from '../services/api-key-service.js';

describe('Auth Middleware', () => {
  const app = Fastify();
  let testUserId: string;
  let validApiKey: string;
  let revokedApiKey: string;
  let lockedApiKey: string;
  const orgA = randomUUID(), orgB = randomUUID(), userId = randomUUID();
  const suffix = randomUUID();
  const cognitoSub = `auth-test-sub-${suffix}`;

  beforeAll(async () => {
    // Set AUTH_ENABLED to true for these tests
    process.env.AUTH_ENABLED = 'true';

    app.register(databasePlugin);
    app.register(dataPlanePlugin);
    app.register(authPlugin);
    app.register(healthRoutes);
    app.register(initRoutes);
    app.get('/auth-context', async (request) => request.auth);
    app.setErrorHandler((error: any, _request, reply) => reply.code(error.name === 'AuthorizationError' ? 403 : error.statusCode ?? 500).send({ error: error.message }));
    await app.ready();

    await app.controlDb.query(`INSERT INTO organizations (id, owner_id, name, personal, plan_id)
      VALUES ($1,$3,'Auth A',false,'playground'),($2,$3,'Auth B',true,'playground')`, [orgA, orgB, userId]);
    await app.controlDb.query(`INSERT INTO platform_users (id, email, cognito_sub, personal_organization_id)
      VALUES ($1,$2,$3,$4)`, [userId, `auth-${suffix}@example.invalid`, cognitoSub, orgB]);
    testUserId = userId;
    await app.controlDb.query(`INSERT INTO organization_members (organization_id,user_id,role)
      VALUES ($1,$3,'owner'),($2,$3,'owner')`, [orgA, orgB, userId]);
    const client = await app.controlDb.connect();
    try {
      await client.query('BEGIN');
      await mintOrganizationLockedApiKeyInTransaction(client, { userId, organizationId: orgA, name: 'Managed auth test' }, async (key) => { lockedApiKey = key; });
      await client.query('COMMIT');
    } finally { client.release(); }

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
    await app.controlDb.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [[orgA, orgB]]);
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

  it('returns 401 for invalid JWT tokens', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/apps',
      headers: {
        'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test'
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toContain('Invalid JWT token');
  });
  it('propagates managed lock and denies a second org owned by the same user', async () => {
    const headers = { authorization: `Bearer ${lockedApiKey}` };
    const allowed = await app.inject({ url: '/auth-context', headers });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ organizationLocked: true, organizationId: orgA });
    expect((await app.inject({ url: '/auth-context', headers: { ...headers, 'x-organization-id': orgB } })).statusCode).toBe(403);
  });
  it('rejects removed-owner work even after a successful cached request', async () => {
    const headers = { authorization: `Bearer ${lockedApiKey}` };
    expect((await app.inject({ url: '/auth-context', headers })).statusCode).toBe(200);
    await app.controlDb.query('DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2', [orgA, userId]);
    try { expect((await app.inject({ url: '/auth-context', headers })).statusCode).toBe(403); }
    finally { await app.controlDb.query("INSERT INTO organization_members (organization_id,user_id,role) VALUES ($1,$2,'owner')", [orgA, userId]); }
  });
  it('preserves interactive JWT organization selection', async () => {
    const token = await LocalAuthProvider.createDevToken(cognitoSub, `auth-${suffix}@example.invalid`, config.auth.jwtSecret);
    const response = await app.inject({ url: '/auth-context', headers: { authorization: `Bearer ${token}`, 'x-organization-id': orgB } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authMethod: 'jwt', organizationId: orgB });
    expect(response.json().organizationLocked).not.toBe(true);
  });

});
