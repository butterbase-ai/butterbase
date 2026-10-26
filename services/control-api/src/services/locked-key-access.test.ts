import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import crypto from 'node:crypto';
import authPlugin from '../plugins/auth.js';
import { initRoutes } from '../routes/init.js';
import { mcpRoutes } from '../routes/mcp.js';
import { aiConfigRoutes } from '../routes/ai-config.js';
import { apiKeyRoutes } from '../routes/api-keys.js';
import { ApiKeyService } from './api-key-service.js';
const { cache, runtime } = vi.hoisted(() => ({ cache: new Map<string, string>(), runtime: { query: vi.fn() } }));
vi.mock('./redis.js', () => ({ getRedisClient: () => ({ get: async (key: string) => cache.get(key), setex: async (key: string, _ttl: number, val: string) => cache.set(key, val), del: async (key: string) => cache.delete(key) }) }));
vi.mock('./key-invalidation.js', () => ({ onKeyInvalidated: vi.fn() }));
vi.mock('./runtime-db.js', () => ({ getRuntimeDbPool: () => runtime }));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const token = 'bb_sk_locked_test';
const cachedKey = `auth:apikey:${crypto.createHash('sha256').update(token).digest('hex')}`;
let currentOwner = true;
let revoked = false;
let locked = true;
const query = vi.fn(async (sql: string, params?: any[]) => {
  if (sql.includes('SELECT i.app_id')) return { rows: [{ app_id: 'app_a', organization_id: A, region: 'local' }, { app_id: 'app_b', organization_id: B, region: 'local' }] };
  if (sql.includes('SELECT app_id, organization_id')) return { rows: [{ app_id: 'app_a', organization_id: A, region: 'local' }] };
  if (sql.includes('INSERT INTO api_keys')) return { rows: [{ id: 'delegated-key', name: 'escape' }], rowCount: 1 };
  if (sql.includes('UPDATE api_keys')) return { rows: [{ id: 'foreign-key' }], rowCount: 1 };
  if (sql.includes('FROM platform_users')) return { rows: [{ personal_organization_id: A }], rowCount: 1 };
  if (sql.includes('FROM api_keys')) {
    if (sql.includes('JOIN') && (!currentOwner || revoked)) return { rows: [], rowCount: 0 };
    return { rows: [{ id: 'key', user_id: 'owner', organization_id: A, organization_locked: locked, key_hash: crypto.createHash('sha256').update(token).digest('hex'), scopes: ['*'], revoked_at: revoked ? new Date() : null }], rowCount: 1 };
  }
  if (sql.includes('organization_members')) return { rows: currentOwner ? [{}] : [], rowCount: currentOwner ? 1 : 0 };
  if (sql.includes('org_app_index')) return { rows: [{ region: 'local' }] };
  return { rows: [], rowCount: 0 };
});
async function build() {
  const app = Fastify();
  app.decorate('controlDb', { query });
  app.decorate('runtimeDb', () => runtime);
  app.setErrorHandler((error: any, _req, reply) => reply.code(error.name === 'AppNotFoundError' ? 404 : error.name === 'AuthorizationError' ? 403 : 500).send({ error: error.message }));
  await app.register(authPlugin);
  await app.register(apiKeyRoutes);
  app.get('/admin/probe', async () => ({ allowed: true }));
  app.get('/probe', async () => ({ allowed: true }));
  app.get('/v1/:appId/probe', async () => ({ allowed: true }));
  app.get('/apps/:app_id/probe', async () => ({ allowed: true }));
  await app.register(mcpRoutes);
  await app.register(initRoutes);
  await app.register(aiConfigRoutes);
  return app;
}
const headers = { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' };
beforeEach(() => {
  cache.clear(); query.mockClear(); currentOwner = true; revoked = false; locked = true;
  runtime.query.mockResolvedValue({ rows: [{ id: 'app_b', owner_id: 'owner', organization_id: B }] });
});
describe('locked key authenticated boundaries', () => {
  it.each([B, 'forged-uuid'])('rejects conflicting header %s', async (org) => {
    const app = await build();
    expect((await app.inject({ url: '/probe', headers: { ...headers, 'x-organization-id': org } })).statusCode).toBe(403);
    await app.close();
  });
  it.each(['/v1/app_b/probe', '/apps/app_b/probe'])('rejects direct app HTTP path %s', async (url) => {
    const app = await build();
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
    await app.close();
  });
  it.each([{ org_id: B }, { app_id: 'app_b' }, { target_app_id: 'app_b' }, { substrate_organization_id: B }, { dest_app_id: 'app_b' }])('rejects MCP target arguments %j before dispatch', async (args) => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'manage_app', arguments: { ...args, action: 'get' } } } });
    expect([403, 404]).toContain(res.statusCode);
    expect(res.json().dispatched).not.toBe(true);
    await app.close();
  });
  it('allows the bound org and app with canonical binding', async () => {
    runtime.query.mockResolvedValue({ rows: [{ id: 'app_a', owner_id: 'owner', organization_id: A }] });
    const app = await build();
    expect((await app.inject({ url: '/v1/app_a/probe', headers: { ...headers, 'x-organization-id': A } })).statusCode).toBe(200);
    await app.close();
  });
  it('refreshes legacy cached auth without the lock flag', async () => {
    cache.set(cachedKey, JSON.stringify({ authMethod: 'api_key', userId: 'owner', keyId: 'key', scopes: ['*'], organizationId: A }));
    const result = await ApiKeyService.validateApiKey({ query } as any, token);
    expect(result).toMatchObject({ organizationLocked: true });
  });
  it('propagates the lock on cache hits', async () => {
    await ApiKeyService.validateApiKey({ query } as any, token);
    const result = await ApiKeyService.validateApiKey({ query } as any, token);
    expect(result).toMatchObject({ organizationLocked: true });
  });
  it.each(['owner removed', 'key revoked'])('stops cache-hit work after %s', async (change) => {
    const app = await build();
    expect((await app.inject({ url: '/probe', headers })).statusCode).toBe(200);
    if (change === 'owner removed') currentOwner = false; else revoked = true;
    expect((await app.inject({ url: '/probe', headers })).statusCode).toBe(403);
    await app.close();
  });
  it.each(['POST', 'DELETE'] as const)('denies %s credential delegation or cross-org key mutation', async (method) => {
    const app = await build();
    const res = await app.inject({ method, url: method === 'POST' ? '/api-keys' : '/api-keys/foreign-key', headers, ...(method === 'POST' ? { payload: { name: 'escape', organization_id: B, organization_locked: false } } : {}) });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
  it('preserves ordinary-key header and direct-owner behavior', async () => {
    locked = false;
    const app = await build();
    expect((await app.inject({ url: '/v1/app_b/probe', headers: { ...headers, 'x-organization-id': B } })).statusCode).toBe(200);
    await app.close();
  });
});

describe('real route containment and enumeration', () => {
  it('does not enumerate another organization apps for a locked key', async () => {
    runtime.query.mockResolvedValue({ rows: [{ id: 'app_a', organization_id: A }, { id: 'app_b', organization_id: B }, { id: 'app_legacy', organization_id: null }] });
    const app = await build();
    const response = await app.inject({ url: '/apps', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().apps.map((row: any) => row.id)).toEqual(['app_a']);
    await app.close();
  });
  it('denies account key enumeration for a locked key', async () => {
    const app = await build();
    expect((await app.inject({ url: '/api-keys', headers })).statusCode).toBe(403);
    await app.close();
  });
  it('real per-app AI route rejects cross-org ownership before invoking a model', async () => {
    const app = await build();
    const response = await app.inject({ method: 'POST', url: '/v1/app_b/chat/completions', headers, payload: { model: 'test', messages: [] } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

it('invalidates a committed lock change before the next cached authentication', async () => {
  locked = false;
  await ApiKeyService.validateApiKey({ query } as any, token);
  locked = true; // Represents a completed trusted database transaction.
  await ApiKeyService.invalidateKeyCache({ query } as any, 'key');
  expect(await ApiKeyService.validateApiKey({ query } as any, token)).toMatchObject({ organizationLocked: true });
});

it('does not let the public user-key route opt into managed credentials', async () => {
  locked = false;
  const app = await build();
  const response = await app.inject({ method: 'POST', url: '/api-keys', headers, payload: { name: 'escape', organization_id: A, organization_locked: true } });
  expect(response.statusCode).toBe(201);
  const insertion = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO api_keys'));
  expect(insertion?.[1]?.[8]).toBe(false);
  await app.close();
});

it('denies account-wide admin access for a managed key even in local auth mode', async () => {
  const app = await build();
  expect((await app.inject({ url: '/admin/probe', headers })).statusCode).toBe(403);
  await app.close();
});
