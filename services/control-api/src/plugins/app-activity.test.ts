import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mark = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../services/app-activity.js', () => ({ markAppActive: mark }));
const { default: activityPlugin } = await import('./app-activity.js');
let app: FastifyInstance;

beforeEach(async () => {
  mark.mockClear();
  app = Fastify();
  app.decorate('controlDb', {} as never);
  app.decorateRequest('subdomainAppId', undefined);
  app.addHook('onRequest', async (req) => {
    if (req.headers.host === 'demo.example') req.subdomainAppId = 'app_demo';
  });
  await app.register(activityPlugin);
  app.get('/v1/:app_id/config', async () => ({ ok: true }));
  app.get('/storage/:appId/objects', async () => ({ ok: true }));
  app.get('/v1/:app_id/status/:code', async (req, reply) => reply.code(Number((req.params as any).code)).send({}));
  app.get('/v1/:app_id/replay', async (_req, reply) => reply.header('fly-replay', 'region=sjc').send());
  app.get('/internal/:app_id/work', async () => ({}));
  app.get('/v1/templates/:app_id', async () => ({}));
  app.get('/health', async () => ({}));
  app.get('/data', async () => ({}));
});
afterEach(async () => { await app.close(); });

describe('request activity', () => {
  it.each(['/v1/app_demo/config', '/storage/app_demo/objects'])('counts real app traffic on %s', async (url) => {
    expect((await app.inject(url)).statusCode).toBe(200);
    expect(mark).toHaveBeenCalledWith(app.controlDb, 'app_demo', expect.anything());
  });
  it('counts resolved subdomain traffic', async () => {
    await app.inject({ url: '/data', headers: { host: 'demo.example' } });
    expect(mark).toHaveBeenCalledWith(app.controlDb, 'app_demo', expect.anything());
  });
  it.each(['/internal/app_demo/work', '/v1/templates/app_demo', '/health', '/missing',
    '/v1/app_demo/status/500', '/v1/app_demo/status/503', '/v1/app_demo/replay'])('does not count %s', async (url) => {
    await app.inject(url);
    expect(mark).not.toHaveBeenCalled();
  });
  it('counts client errors below 500, as specified', async () => {
    await app.inject('/v1/app_demo/status/404');
    expect(mark).toHaveBeenCalledOnce();
  });
});
