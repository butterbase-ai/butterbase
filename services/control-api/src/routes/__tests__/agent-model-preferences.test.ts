import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../services/redis.js', () => ({ getRedisClient: () => ({}) }));
vi.mock('../../services/ai-router/catalog.js', () => ({ readCatalogEntry: vi.fn() }));
import { readCatalogEntry } from '../../services/ai-router/catalog.js';
import { registerAgentModelPreferencesRoutes } from '../agent-model-preferences.js';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.clearAllMocks(); });
async function setup(role: 'owner' | 'member' | 'stranger' = 'owner', authMethod = 'jwt') {
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.includes('JOIN organization_members') && role === 'stranger') return { rows: [] };
    if (sql.includes('UPDATE organizations') && role !== 'owner') return { rows: [] };
    return { rows: [{ model: sql.startsWith('UPDATE') ? values.at(-1) : null }] };
  });
  const app = Fastify(); apps.push(app); app.decorateRequest('auth', null);
  app.addHook('onRequest', async request => { request.auth = { userId: 'signed-in-user', authMethod, scopes: ['*'] } as any; });
  app.decorate('controlDb', { query } as any);
  registerAgentModelPreferencesRoutes(app, () => true);
  return { app, query };
}
it('returns the personal effective default and saves only the signed-in user', async () => {
  const { app, query } = await setup();
  expect((await app.inject('/preferences')).json()).toMatchObject({ model: null, effective_model: 'deepseek/deepseek-v4.1-flash' });
  vi.mocked(readCatalogEntry).mockResolvedValue({ routers: [{ modality: 'chat' }] } as any);
  const response = await app.inject({ method: 'PATCH', url: '/preferences', payload: { model: 'vendor/chat' } });
  expect(response.statusCode).toBe(200);
  expect(query.mock.calls.at(-1)?.[1]).toEqual(['signed-in-user', 'vendor/chat']);
});
it('rejects unsupported/non-chat models and client-supplied identity fields before writing', async () => {
  const { app, query } = await setup();
  vi.mocked(readCatalogEntry).mockResolvedValue({ routers: [{ modality: 'video' }] } as any);
  for (const payload of [{ model: 'vendor/video' }, { model: 'vendor/chat', user_id: 'someone-else' }]) {
    expect((await app.inject({ method: 'PATCH', url: '/preferences', payload })).statusCode).toBe(400);
  }
  expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
});
it('allows members to read organization defaults and only owners to change them', async () => {
  const { app } = await setup('member');
  const headers = { 'x-organization-id': '11111111-1111-4111-8111-111111111111' };
  expect((await app.inject({ url: '/operator/model', headers })).statusCode).toBe(200);
  expect((await app.inject({ method: 'PATCH', url: '/operator/model', headers, payload: { model: null } })).statusCode).toBe(403);
});
it('requires an explicit organization and membership, including on reset', async () => {
  const { app } = await setup('stranger');
  expect((await app.inject('/operator/model')).statusCode).toBe(400);
  expect((await app.inject({ url: '/operator/model', headers: { 'x-organization-id': '11111111-1111-4111-8111-111111111111' } })).statusCode).toBe(403);
});
it('does not let managed API keys change human preferences', async () => {
  const { app, query } = await setup('owner', 'api_key');
  expect((await app.inject({ method: 'PATCH', url: '/preferences', payload: { model: null } })).statusCode).toBe(403);
  expect(query).not.toHaveBeenCalled();
});
