import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// F1: the custom-domain KV write must be followed by a paused re-sync from the DB,
// and a re-sync failure must never fail the route.

const runtimeQuery = vi.fn();

vi.mock('../services/app-resolver.js', () => ({
  AppResolver: { resolveApp: vi.fn().mockResolvedValue({ id: 'app_test' }) },
}));
vi.mock('../services/audit/with-audit.js', () => ({ logFromRequest: vi.fn() }));
vi.mock('../utils/require-auth.js', () => ({ requireUserId: vi.fn().mockReturnValue('user_test') }));
vi.mock('../config.js', () => ({
  config: {
    cloudflare: { enabled: true, customHostnameFallbackOrigin: 'butterbase.dev' },
    subdomain: { baseDomain: 'butterbase.dev' },
    runtimeDb: {},
  },
}));
vi.mock('../services/region-resolver.js', () => ({
  resolveAppHomeRegion: vi.fn(async () => 'local'),
}));
vi.mock('../services/runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(() => ({ query: runtimeQuery })),
}));
vi.mock('../services/plan-features.js', () => ({
  getAppPlanFeatures: vi.fn(async () => ({ custom_domain: true })),
}));
vi.mock('../services/cloudflare-custom-hostnames.js', () => ({
  createCustomHostname: vi.fn(async () => ({ id: 'cf_1', status: 'pending', ssl: { status: 'pending' } })),
}));
vi.mock('../services/cloudflare-wfp.js', () => ({
  writeDomainMapping: vi.fn().mockResolvedValue(undefined),
  deleteDomainMapping: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/frontend-pause-sync.js', () => ({
  syncFrontendPausedState: vi.fn().mockResolvedValue({ rewritten: [] }),
}));

import { customDomainRoutes } from '../routes/custom-domains.js';
import { writeDomainMapping } from '../services/cloudflare-wfp.js';
import { syncFrontendPausedState } from '../services/frontend-pause-sync.js';

async function build() {
  const app = Fastify();
  const controlDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  app.decorate('controlDb', controlDb);
  app.decorateRequest('auth', null as any);
  app.addHook('onRequest', async (request: any) => { request.auth = { userId: 'user_test', scopes: ['*'] }; });
  app.register(customDomainRoutes);
  await app.ready();
  return { app, controlDb };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtimeQuery.mockImplementation(async (sql: string) => {
    if (/deployment_backend, paused/.test(sql)) return { rows: [{ deployment_backend: 'wfp', paused: false }] };
    if (/SELECT id, app_id FROM app_custom_domains/.test(sql)) return { rows: [] };
    if (/INSERT INTO app_custom_domains/.test(sql)) return { rows: [{ id: 'dom_1', hostname: 'shop.example.com' }] };
    return { rows: [] };
  });
  (writeDomainMapping as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (syncFrontendPausedState as ReturnType<typeof vi.fn>).mockResolvedValue({ rewritten: [] });
});

describe('POST /v1/:appId/custom-domains paused re-sync', () => {
  const post = (app: ReturnType<typeof Fastify>) =>
    app.inject({ method: 'POST', url: '/v1/app_test/custom-domains', payload: { hostname: 'shop.example.com' } });

  it('re-syncs paused state from the DB after the KV write', async () => {
    const { app, controlDb } = await build();
    const order: string[] = [];
    (writeDomainMapping as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('write'); });
    (syncFrontendPausedState as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('sync'); return { rewritten: [] }; });

    const res = await post(app);

    expect(res.statusCode).toBe(201);
    expect(syncFrontendPausedState).toHaveBeenCalledWith(controlDb, 'app_test');
    expect(order).toEqual(['write', 'sync']);
    await app.close();
  });

  it('still returns 201 when the re-sync rejects', async () => {
    const { app } = await build();
    (syncFrontendPausedState as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cf down'));

    const res = await post(app);

    expect(res.statusCode).toBe(201);
    await app.close();
  });
});
