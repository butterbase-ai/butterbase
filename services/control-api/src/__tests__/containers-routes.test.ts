import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../services/containers.service.js', () => ({
  registerContainer: vi.fn(),
  listContainers: vi.fn(),
  getContainer: vi.fn(),
  deleteContainer: vi.fn(),
  setContainerEnvVar: vi.fn(),
  deleteContainerEnvVar: vi.fn(),
  listContainerEnvVarKeys: vi.fn(),
  ContainerError: class extends Error {
    constructor(message: string, public code: string) { super(message); }
  },
}));

vi.mock('../services/app-resolver.js', () => ({
  AppResolver: { resolveApp: vi.fn().mockResolvedValue({ id: 'app_xyz' }) },
  AppNotFoundError: class extends Error {},
}));

// Route resolves the per-app runtime pool via region-resolver. The stub
// just returns an empty object so the service mocks below run unchanged.
vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(async () => ({} as unknown)),
  resolveAppHomeRegion: vi.fn(async () => 'local'),
}));

vi.mock('../utils/require-auth.js', () => ({
  requireUserId: vi.fn().mockReturnValue('user_1'),
}));

vi.mock('../services/audit/with-audit.js', () => ({
  logFromRequest: vi.fn(),
}));

import * as Service from '../services/containers.service.js';
import { registerContainerRoutes } from '../routes/containers.js';

// Stub controlDb (used directly for image-pushed upsert and passed to service)
const controlDbStub = {
  query: vi.fn().mockResolvedValue({ rows: [] }),
};

async function buildApp() {
  const app = Fastify();
  (app as any).controlDb = controlDbStub as any;
  await registerContainerRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  controlDbStub.query.mockResolvedValue({ rows: [] });
});

// ---------------------------------------------------------------------------
// POST /v1/:appId/containers — deploy
// ---------------------------------------------------------------------------
describe('POST /v1/:appId/containers', () => {
  const validPayload = {
    name: 'game-server',
    image_digest: 'sha256:' + 'a'.repeat(64),
  };

  it('calls registerContainer and returns 200', async () => {
    (Service.registerContainer as any).mockResolvedValue({ id: 'ctr_1', name: 'game-server', status: 'READY' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/app_xyz/containers',
      payload: validPayload,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: 'ctr_1', status: 'READY' });
    expect(Service.registerContainer).toHaveBeenCalledOnce();
  });

  it('maps IMAGE_NOT_FOUND → 400', async () => {
    (Service.registerContainer as any).mockRejectedValue(
      new (Service as any).ContainerError('Image not found', 'IMAGE_NOT_FOUND'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/app_xyz/containers',
      payload: validPayload,
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain('Image not found');
  });

  it('maps CF_DEPLOY_FAILED → 502', async () => {
    (Service.registerContainer as any).mockRejectedValue(
      new (Service as any).ContainerError('CF blew up', 'CF_DEPLOY_FAILED'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/app_xyz/containers',
      payload: validPayload,
    });
    expect(res.statusCode).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/:appId/containers — list
// ---------------------------------------------------------------------------
describe('GET /v1/:appId/containers', () => {
  it('returns the list of containers', async () => {
    (Service.listContainers as any).mockResolvedValue([
      { id: 'ctr_1', name: 'game-server', status: 'READY' },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/app_xyz/containers' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).containers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/:appId/containers/:name
// ---------------------------------------------------------------------------
describe('GET /v1/:appId/containers/:name', () => {
  it('returns the container when found', async () => {
    (Service.getContainer as any).mockResolvedValue({ id: 'ctr_1', name: 'game-server', status: 'READY' });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/app_xyz/containers/game-server' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('game-server');
  });

  it('returns 404 when not found', async () => {
    (Service.getContainer as any).mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/app_xyz/containers/missing' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/:appId/containers/:name
// ---------------------------------------------------------------------------
describe('DELETE /v1/:appId/containers/:name', () => {
  it('deletes and returns 200', async () => {
    (Service.deleteContainer as any).mockResolvedValue(undefined);
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/v1/app_xyz/containers/game-server' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(true);
    expect(JSON.parse(res.body).name).toBe('game-server');
  });

  it('returns 404 on NOT_FOUND from service', async () => {
    (Service.deleteContainer as any).mockRejectedValue(
      new (Service as any).ContainerError('Container not found', 'NOT_FOUND'),
    );
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/v1/app_xyz/containers/missing' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/:appId/containers/:name/env/:key
// ---------------------------------------------------------------------------
describe('PUT /v1/:appId/containers/:name/env/:key', () => {
  it('sets env var and returns 200 with redeployed flag', async () => {
    (Service.setContainerEnvVar as any).mockResolvedValue({ redeployed: true });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/app_xyz/containers/game-server/env/MY_VAR',
      payload: { value: 'hello' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.key).toBe('MY_VAR');
    expect(body.redeployed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /internal/registry/image-pushed
// ---------------------------------------------------------------------------
describe('POST /internal/registry/image-pushed', () => {
  const validSecret = 'supersecret123';
  const validPayload = {
    registry_repo: 'app_abc123/game-server',
    digest: 'sha256:' + 'b'.repeat(64),
    size_bytes: 104857600,
  };

  beforeEach(() => {
    process.env.REGISTRY_FACADE_SHARED_SECRET = validSecret;
  });

  it('upserts into container_images and returns { ok: true } with valid secret', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/registry/image-pushed',
      headers: { 'x-registry-shared-secret': validSecret },
      payload: validPayload,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(controlDbStub.query).toHaveBeenCalledOnce();
    const [sql, params] = controlDbStub.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO container_images');
    expect(sql).toContain('ON CONFLICT');
    expect(params).toContain(validPayload.registry_repo);
    expect(params).toContain(validPayload.digest);
    expect(params).toContain(validPayload.size_bytes);
  });

  it('returns 401 when secret is missing', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/registry/image-pushed',
      payload: validPayload,
    });
    expect(res.statusCode).toBe(401);
    // Auth check before schema parse — controlDb should NOT have been queried
    expect(controlDbStub.query).not.toHaveBeenCalled();
  });

  it('returns 401 when secret is wrong', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/registry/image-pushed',
      headers: { 'x-registry-shared-secret': 'wrong-secret' },
      payload: validPayload,
    });
    expect(res.statusCode).toBe(401);
    expect(controlDbStub.query).not.toHaveBeenCalled();
  });

  it('returns 400 when registry_repo format is invalid (after auth passes)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/registry/image-pushed',
      headers: { 'x-registry-shared-secret': validSecret },
      payload: { ...validPayload, registry_repo: 'invalid/repo/format' },
    });
    expect(res.statusCode).toBe(400);
  });
});
