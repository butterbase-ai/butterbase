import { beforeEach, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { billingRoutes } from './billing.js';
import { getUsageByEnvironment } from '../services/staging-billing-attribution.js';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
vi.mock('../services/staging-billing-attribution.js', () => ({ getUsageByEnvironment: vi.fn(async (_db, org) => ({ organizationId: org })) }));
vi.mock('../services/usage-metering.js', () => ({ getAiCreditsUsed: vi.fn(async () => 0), getCurrentUsage: vi.fn(async () => 0), getStorageUsed: vi.fn(async () => 0), getDbSize: vi.fn(async () => 0), getMAU: vi.fn(async () => 0), getCreditsBalance: vi.fn(async () => ({ monthlyAllowanceUsd: 0, topupUsd: 0, totalUsd: 0 })) }));
vi.mock('../config.js', async (original) => ({ ...(await original<any>()), assertRegionConfig: () => ({ instanceRegion: 'local' }) }));
const query = vi.fn(async (sql: string, params?: any[]) => {
  if (sql.includes('organization_members')) return { rows: [{ role: 'owner' }] };
  if (sql.includes('SELECT o.id AS org_id')) return { rows: [{ org_id: params?.[1] ?? B, plan_id: params?.[1] ?? B }] };
  if (sql.includes('SELECT o.spending_cap_usd')) return { rows: [{ spending_cap_usd: null, default_spending_cap_usd: null }] };
  if (sql.includes('personal_organization_id')) return { rows: [{ personal_organization_id: B }] };
  if (sql.includes('SUM(quantity) as total')) return { rows: [{ meter_type: 'api_calls', period_start: '2026-10-26', total: params?.[0] === A ? '1' : '999' }] };
  return { rows: [], rowCount: 0 };
});
async function build(locked = true) {
  const app = Fastify();
  app.decorate('controlDb', { query });
  app.decorate('runtimeDb', () => ({ query }));
  app.addHook('onRequest', async (req) => { req.auth = { userId: 'owner', authMethod: 'api_key', scopes: ['*'], organizationId: A, organizationLocked: locked }; });
  app.setErrorHandler((error: any, _req, reply) => reply.code(error.name === 'AuthorizationError' ? 403 : 500).send({ error: error.message }));
  await app.register(billingRoutes);
  return app;
}
beforeEach(() => vi.clearAllMocks());
describe('locked key no-target billing authority', () => {
  it('uses bound A billing rather than personal B', async () => {
    const app = await build();
    const response = await app.inject({ url: '/dashboard/billing?usage=0' });
    expect(response.statusCode).toBe(200);
    expect(response.json().plan.id).toBe(A);
    expect(query.mock.calls.filter(([sql]) => sql.includes('SELECT o.spending_cap_usd'))[0][1]?.[1]).toBe(A);
    await app.close();
  });
  it('uses bound A usage rather than personal B', async () => {
    const app = await build();
    const response = await app.inject({ url: '/dashboard/usage' });
    expect(response.statusCode).toBe(200);
    expect(response.json().usage.api_calls[0].quantity).toBe(1);
    await app.close();
  });
  it('uses bound A for environment usage', async () => {
    const app = await build();
    const response = await app.inject({ url: '/dashboard/usage/by-environment' });
    expect(response.statusCode).toBe(200);
    expect(response.json().organizationId).toBe(A);
    await app.close();
  });
  it.each(['/dashboard/account', '/dashboard/onboard', '/dashboard/billing/portal'])('denies account mutation %s', async (url) => {
    const app = await build();
    const response = await app.inject({ method: url.endsWith('/account') ? 'DELETE' : 'POST', url, payload: {} });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
  it('preserves ordinary key personal billing selection', async () => {
    const app = await build(false);
    const response = await app.inject({ url: '/dashboard/billing?usage=0' });
    expect(response.statusCode).toBe(200);
    expect(response.json().plan.id).toBe(B);
    await app.close();
  });
});

it('rejects a conflicting explicit billing organization', async () => {
  const app = await build();
  expect((await app.inject({ url: `/dashboard/billing?org_id=${B}&usage=0` })).statusCode).toBe(403);
  await app.close();
});
