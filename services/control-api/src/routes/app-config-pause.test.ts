import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const runtimeQuery = vi.fn();

vi.mock('../config.js', () => ({ config: { runtimeDb: {} } }));
vi.mock('../services/region-resolver.js', () => ({ resolveAppHomeRegion: vi.fn().mockResolvedValue('us-east-1') }));
vi.mock('../services/runtime-db.js', () => ({ getRuntimeDbPool: () => ({ query: runtimeQuery }) }));
vi.mock('../services/audit/with-audit.js', () => ({ logFromRequest: vi.fn() }));
vi.mock('../services/app-plan-resolver.js', () => ({ getLimitsForApp: vi.fn() }));
const isOnIdlePausePlan = vi.fn();
vi.mock('../services/idle-pause-config.js', () => ({ isOnIdlePausePlan }));
vi.mock('../services/app-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/app-resolver.js')>();
  return { ...actual, AppResolver: { resolveApp: vi.fn().mockResolvedValue({ id: 'app_1' }) } };
});

const { appConfigRoutes } = await import('./app-config.js');

async function build() {
  const app = Fastify();
  app.decorate('controlDb', {} as never);
  app.decorateRequest('auth', null as never);
  app.addHook('onRequest', async (req) => {
    (req as any).auth = { userId: 'user_1', authMethod: 'jwt', organizationId: null };
  });
  await appConfigRoutes(app as never);
  return app;
}

beforeEach(() => { runtimeQuery.mockReset(); isOnIdlePausePlan.mockReset().mockResolvedValue(false); });

describe('PATCH /v1/:app_id/config/pause', () => {
  it('pauses as owner and returns paused_by', async () => {
    runtimeQuery.mockResolvedValue({ rows: [{ app_id: 'app_1', paused: true, paused_at: 't', paused_reason: 'incident', paused_by: 'owner' }] });
    const app = await build();
    const res = await app.inject({ method: 'PATCH', url: '/v1/app_1/config/pause', payload: { paused: true, reason: 'incident' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ app_id: 'app_1', paused: true, paused_by: 'owner', paused_reason: 'incident' });
    expect(runtimeQuery.mock.calls[0][1]).toEqual(['app_1', 'incident', 'owner']);
  });

  it('resumes and returns paused_by null', async () => {
    runtimeQuery.mockResolvedValue({ rows: [{ app_id: 'app_1', paused: false, paused_at: null, paused_reason: null, paused_by: null }] });
    const app = await build();
    const res = await app.inject({ method: 'PATCH', url: '/v1/app_1/config/pause', payload: { paused: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ paused: false, paused_by: null });
    expect(runtimeQuery.mock.calls[0][0]).toContain('last_active_at = now()');
  });

  it('resume on a paid plan passes idlePausePlan=false to the guarded UPDATE', async () => {
    runtimeQuery.mockResolvedValue({ rows: [{ app_id: 'app_1', paused: false, paused_at: null, paused_reason: null, paused_by: null }] });
    const app = await build();
    const res = await app.inject({ method: 'PATCH', url: '/v1/app_1/config/pause', payload: { paused: false } });
    expect(res.statusCode).toBe(200);
    expect(isOnIdlePausePlan).toHaveBeenCalledWith(expect.anything(), 'app_1');
    expect(runtimeQuery.mock.calls[0][1]).toEqual(['app_1', false]);
  });

  it('resume of an idle-paused app on a free plan is a 402 telling the owner to upgrade', async () => {
    isOnIdlePausePlan.mockResolvedValue(true);
    runtimeQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'app_1' }] });
    const app = await build();
    const res = await app.inject({ method: 'PATCH', url: '/v1/app_1/config/pause', payload: { paused: false } });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toMatchObject({ code: 'APP_RESUME_REQUIRES_UPGRADE' });
    expect(res.json().error.remediation).toMatch(/upgrade/i);
    expect(runtimeQuery.mock.calls[0][1]).toEqual(['app_1', true]);
  });

  it('pausing does not look up the plan', async () => {
    runtimeQuery.mockResolvedValue({ rows: [{ app_id: 'app_1', paused: true, paused_at: 't', paused_reason: null, paused_by: 'owner' }] });
    const app = await build();
    await app.inject({ method: 'PATCH', url: '/v1/app_1/config/pause', payload: { paused: true } });
    expect(isOnIdlePausePlan).not.toHaveBeenCalled();
  });

  it('404s when the row vanished between resolve and update', async () => {
    runtimeQuery.mockResolvedValue({ rows: [] });
    const app = await build();
    const res = await app.inject({ method: 'PATCH', url: '/v1/app_1/config/pause', payload: { paused: true } });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a body without paused', async () => {
    const app = await build();
    const res = await app.inject({ method: 'PATCH', url: '/v1/app_1/config/pause', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/:app_id/config', () => {
  it('selects the paused fields', async () => {
    runtimeQuery.mockResolvedValue({ rows: [{ id: 'app_1', paused: true, paused_by: 'idle_reaper' }] });
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/v1/app_1/config' });
    expect(res.statusCode).toBe(200);
    expect(runtimeQuery.mock.calls[0][0]).toMatch(/paused, paused_at, paused_reason, paused_by/);
    expect(res.json()).toMatchObject({ paused: true, paused_by: 'idle_reaper' });
  });
});
