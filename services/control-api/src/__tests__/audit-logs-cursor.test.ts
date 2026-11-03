import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

const { mockControlQuery, mockRuntimeQuery } = vi.hoisted(() => ({
  mockControlQuery: vi.fn(),
  mockRuntimeQuery: vi.fn(),
}));

vi.mock('../services/app-resolver.js', () => ({
  AppResolver: { resolveApp: vi.fn(async () => ({ id: 'app_test' })) },
  AppNotFoundError: class AppNotFoundError extends Error {},
}));
vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(async () => ({ query: mockRuntimeQuery })),
}));

import { auditLogRoutes } from '../routes/audit-logs.js';

const APP_ID = 'app_test';
const row = (id: string, at: string) => ({
  id, app_id: APP_ID, category: 'admin', event_type: 'schema.apply', action: null,
  resource_type: null, resource_id: null, actor_type: 'platform_user', actor_id: 'u',
  event_data: {}, ip_address: null, user_agent: null, success: true, error_message: null,
  correlation_id: null, created_at: at,
});

const A = row('00000000-0000-4000-8000-000000000002', '2026-11-03T10:00:02.000Z');
const B = row('00000000-0000-4000-8000-000000000003', '2026-11-03T10:00:01.000Z');
const C = row('00000000-0000-4000-8000-000000000004', '2026-11-03T10:00:02.000Z');
const D = row('00000000-0000-4000-8000-000000000001', '2026-11-03T09:59:00.000Z');
const CURSOR_AT = A.created_at;

function pageFor(params: unknown[]) {
  return params.includes(CURSOR_AT);
}

function installQueries() {
  mockControlQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: 3 }] };
    return { rows: pageFor(params) ? [B] : [A, B] };
  });
  mockRuntimeQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ total: 2 }] };
    return { rows: pageFor(params) ? [D] : [C].concat([A as any]) };
  });
}

async function buildApp() {
  installQueries();
  const app = Fastify();
  app.decorate('controlDb', { query: mockControlQuery } as any);
  app.addHook('onRequest', (req, _reply, done) => {
    (req as any).auth = { userId: 'user-1', organizationId: 'org-1' };
    done();
  });
  app.register(auditLogRoutes);
  await app.ready();
  return app;
}

describe('GET /v1/:app_id/audit-logs cursor pagination', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); });

  it('returns a nextCursor and resumes without duplicates', async () => {
    const first = await app.inject({ method: 'GET', url: `/v1/${APP_ID}/audit-logs?limit=2` });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.logs.map((r: any) => r.id)).toEqual([C.id, A.id]);
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    expect(firstBody.nextOffset).toBe(2);

    const second = await app.inject({ method: 'GET', url: `/v1/${APP_ID}/audit-logs?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}` });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.logs.map((r: any) => r.id)).toEqual([B.id, D.id]);
    expect(secondBody.logs.every((r: any) => !firstBody.logs.some((old: any) => old.id === r.id))).toBe(true);
    expect(secondBody.nextOffset).toBeNull();
  });

  it('orders equal timestamps by id descending', async () => {
    const first = await app.inject({ method: 'GET', url: `/v1/${APP_ID}/audit-logs?limit=2` });
    const timestamps = first.json().logs.map((r: any) => r.created_at);
    expect(timestamps).toEqual([C.created_at, A.created_at]);
    expect(first.json().logs[0].id.localeCompare(first.json().logs[1].id)).toBeGreaterThan(0);
  });

  it('rejects a malformed cursor', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/${APP_ID}/audit-logs?cursor=not-a-cursor` });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('VALIDATION_INVALID_CURSOR');
  });

  it('rejects cursor combined with offset', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/${APP_ID}/audit-logs?cursor=not-a-cursor&offset=2` });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('VALIDATION_CONFLICTING_PAGINATION');
  });
});
