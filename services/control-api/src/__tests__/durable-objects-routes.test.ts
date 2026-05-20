import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../services/durable-objects.service.js', () => ({
  registerDurableObject: vi.fn(),
  listDurableObjects: vi.fn(),
  getDurableObject: vi.fn(),
  deleteDurableObject: vi.fn(),
  getDurableObjectUsage: vi.fn(),
  DurableObjectError: class extends Error {
    constructor(message: string, public code: string) { super(message); }
  },
}));

vi.mock('../services/app-resolver.js', () => ({
  AppResolver: { resolveApp: vi.fn().mockResolvedValue({ id: 'app_xyz' }) },
  AppNotFoundError: class extends Error {},
}));

vi.mock('../utils/require-auth.js', () => ({
  requireUserId: vi.fn().mockReturnValue('user_1'),
}));

vi.mock('../services/audit/with-audit.js', () => ({
  logFromRequest: vi.fn(),
}));

import * as Service from '../services/durable-objects.service.js';
import { registerDurableObjectRoutes } from '../routes/durable-objects.js';

async function buildApp() {
  const app = Fastify();
  // Minimal controlDb stub.
  (app as any).controlDb = {} as any;
  await registerDurableObjectRoutes(app);
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('POST /v1/:appId/durable-objects', () => {
  it('creates a DO and returns 200 with the result', async () => {
    (Service.registerDurableObject as any).mockResolvedValue({ id: 'do_1', name: 'chat-room', status: 'READY' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/app_xyz/durable-objects',
      payload: { name: 'chat-room', code: 'export class ChatRoom {}', access_mode: 'public' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: 'do_1', status: 'READY' });
  });

  it('returns 400 with the bundler error code when source is invalid', async () => {
    (Service.registerDurableObject as any).mockRejectedValue(
      new (Service as any).DurableObjectError('Source must export exactly one class. None found.', 'NO_EXPORTED_CLASS'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/app_xyz/durable-objects',
      payload: { name: 'bad', code: 'const x = 1;', access_mode: 'public' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain('Source must export exactly one class');
  });
});

describe('GET /v1/:appId/durable-objects', () => {
  it('returns the list', async () => {
    (Service.listDurableObjects as any).mockResolvedValue([
      { id: 'do_1', name: 'chat-room', class_name: 'ChatRoom', status: 'READY', access_mode: 'public', last_deployed_at: new Date(), error_message: null },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/app_xyz/durable-objects' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).durable_objects).toHaveLength(1);
  });
});

describe('GET /v1/:appId/durable-objects/:name', () => {
  it('returns the DO with code', async () => {
    (Service.getDurableObject as any).mockResolvedValue({
      id: 'do_1', name: 'chat-room', class_name: 'ChatRoom',
      code: 'export class ChatRoom {}', access_mode: 'public', status: 'READY',
      error_message: null, last_deployed_at: new Date(), created_at: new Date(), updated_at: new Date(),
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/app_xyz/durable-objects/chat-room' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe('export class ChatRoom {}');
  });

  it('returns 404 when not found', async () => {
    (Service.getDurableObject as any).mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/app_xyz/durable-objects/missing' });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /v1/:appId/durable-objects/:name', () => {
  it('deletes and returns 200', async () => {
    (Service.deleteDurableObject as any).mockResolvedValue(undefined);
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/v1/app_xyz/durable-objects/chat-room' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(true);
  });

  it('returns 404 on NOT_FOUND from the service', async () => {
    (Service.deleteDurableObject as any).mockRejectedValue(
      new (Service as any).DurableObjectError('DO not found', 'NOT_FOUND'),
    );
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/v1/app_xyz/durable-objects/missing' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/:appId/durable-objects/:name/usage', () => {
  it('returns usage for the current month', async () => {
    (Service.getDurableObjectUsage as any).mockResolvedValue({
      do_requests: 1234, do_cpu_ms: 56789,
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/app_xyz/durable-objects/chat-room/usage' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      do_requests: 1234, do_cpu_ms: 56789,
    });
  });
});
