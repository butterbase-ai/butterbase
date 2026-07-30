import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../services/app-resolver.js', () => ({
  AppResolver: { resolveApp: vi.fn().mockResolvedValue({ id: 'app_123' }) },
}));
vi.mock('../../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(),
}));
vi.mock('../../services/crypto.js', () => ({
  encrypt: vi.fn((data) => `encrypted_${data}`),
  decrypt: vi.fn((data) => data.replace('encrypted_', '')),
}));
vi.mock('../../utils/cache-invalidation.js', () => ({
  invalidateFunctionCache: vi.fn().mockResolvedValue({ success: true, attempts: 1 }),
}));
vi.mock('../../services/audit/with-audit.js', () => ({
  logFromRequest: vi.fn(),
}));
vi.mock('../../utils/require-auth.js', () => ({
  requireUserId: vi.fn(() => 'test-user-id'),
}));
vi.mock('../../services/durable-objects.service.js', () => ({
  redeployIfActive: vi.fn(),
}));

import Fastify from 'fastify';
import { registerAppEnvRoutes } from '../app-env.js';
import { getRuntimeDbForApp } from '../../services/region-resolver.js';
import { redeployIfActive } from '../../services/durable-objects.service.js';

describe('PATCH /v1/:appId/env DO redeploy fanout', () => {
  let app: FastifyInstance;
  let mockRuntimeDb: { query: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.stubEnv('AUTH_ENCRYPTION_KEY', '00'.repeat(32));
    vi.clearAllMocks();
    mockRuntimeDb = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })                    // SELECT existing app_env_vars
        .mockResolvedValueOnce({ rows: [] })                    // INSERT app_env_vars (UPSERT)
        .mockResolvedValueOnce({ rows: [{ name: 'fn-a' }] }),   // SELECT fn names for fanout
    };
    (getRuntimeDbForApp as any).mockResolvedValue(mockRuntimeDb);

    app = Fastify();
    (app as any).controlDb = { query: vi.fn() };
    await app.register(registerAppEnvRoutes);
    await app.ready();
  });

  afterEach(async () => { await app.close(); });

  it('redeploys DO worker after PATCH when active DO classes exist', async () => {
    (redeployIfActive as any).mockResolvedValue(true);
    const res = await app.inject({
      method: 'PATCH', url: '/v1/app_123/env',
      payload: { envVars: { STRIPE_SECRET: 'sk_new' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().invalidated.durable_objects_redeployed).toBe(true);
    expect(redeployIfActive).toHaveBeenCalledOnce();
  });

  it('reports durable_objects_redeployed=false when app has no active DOs', async () => {
    (redeployIfActive as any).mockResolvedValue(false);
    const res = await app.inject({
      method: 'PATCH', url: '/v1/app_123/env',
      payload: { envVars: { STRIPE_SECRET: 'sk_1' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().invalidated.durable_objects_redeployed).toBe(false);
    expect(redeployIfActive).toHaveBeenCalledOnce();
  });

  it('absorbs redeployIfActive errors as warnings, still returns 200', async () => {
    (redeployIfActive as any).mockRejectedValue(new Error('CF deploy exploded'));
    const res = await app.inject({
      method: 'PATCH', url: '/v1/app_123/env',
      payload: { envVars: { STRIPE_SECRET: 'sk_1' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().invalidated.durable_objects_redeployed).toBe(false);
  });
});
