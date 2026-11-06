import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerFunctionRoutes } from './functions.js';
import { storageRoutes } from './storage.js';
import { incrementUsage } from '../services/usage-metering.js';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
vi.mock('../services/usage-metering.js', () => ({ incrementUsage: vi.fn(async () => {}) }));
vi.mock('../services/org-resolver.js', () => ({ resolveOrganizationId: async () => '22222222-2222-4222-8222-222222222222' }));
vi.mock('../services/end-user-auth.js', () => ({ verifyEndUserJwt: vi.fn() }));
vi.mock('../services/audit/with-audit.js', () => ({ logFromRequest: vi.fn() }));
vi.mock('../services/app-resolver.js', async (original) => ({ ...(await original<any>()), AppResolver: { resolveApp: async () => ({ id: 'app_a', organization_id: A }) } }));
const { runtime } = vi.hoisted(() => ({ runtime: { query: vi.fn(async (sql: string) => ({ rows: sql.includes('FROM storage_objects') ? [{ key: 'asset', filename: 'asset', size_bytes: 5 }] : [{ owner_id: 'owner' }] })) } }));
vi.mock('../services/region-resolver.js', () => ({ resolveAppHomeRegion: async () => 'local', getRuntimeDbForApp: async () => runtime }));
vi.mock('../services/runtime-db.js', () => ({ getRuntimeDbPool: () => runtime }));
vi.mock('../services/s3.js', () => ({ generatePresignedUploadUrl: vi.fn(), generatePresignedDownloadUrl: async () => 'https://example.invalid/asset', deleteObject: vi.fn(), S3Error: class S3Error extends Error {} }));
async function build(locked: boolean) {
  const app = Fastify();
  app.decorate('controlDb', { query: vi.fn(async () => ({ rows: [] })) });
  app.addHook('onRequest', async (request) => { request.auth = { userId: 'owner', authMethod: 'api_key', scopes: ['*'], organizationId: A, organizationLocked: locked }; });
  await app.register(registerFunctionRoutes);
  await app.register(storageRoutes);
  return app;
}
describe('managed app usage attribution', () => {
  it.each([true, false])('tracks invocation in the authorized org for locked=%s', async (locked) => {
    vi.mocked(incrementUsage).mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const app = await build(locked);
    const response = await app.inject({ method: 'POST', url: '/v1/app_a/functions/test/invoke', payload: {} });
    expect(response.statusCode).toBe(200);
    expect(incrementUsage).toHaveBeenCalledWith(locked ? A : B, 'owner', 'lambda_invocations', 1, 'app_a');
    await app.close(); vi.unstubAllGlobals();
  });
  it.each([true, false])('tracks download in the authorized org for locked=%s', async (locked) => {
    vi.mocked(incrementUsage).mockClear();
    const app = await build(locked);
    const response = await app.inject({ url: '/storage/app_a/download/object' });
    expect(response.statusCode).toBe(200);
    expect(incrementUsage).toHaveBeenCalledWith(locked ? A : B, 'owner', 'bandwidth_bytes', 5, 'app_a');
    await app.close();
  });
});
