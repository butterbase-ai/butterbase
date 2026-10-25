import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { cronOriginHeaders, verifyCronOrigin } from '../services/cron-origin.js';

const mark = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../services/app-activity.js', () => ({ markAppActive: mark }));
const { default: activityPlugin } = await import('./app-activity.js');
let app: FastifyInstance;

beforeEach(async () => {
  vi.stubEnv('BUTTERBASE_INTERNAL_SECRET', 'cron-origin-test-secret');
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
afterEach(async () => { await app.close(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function origin(appId = 'app_demo', issuedAt = Math.floor(Date.now() / 1000), secret = 'cron-origin-test-secret') {
  const payload = Buffer.from(JSON.stringify({ appId, iat: issuedAt, exp: issuedAt + 900 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`butterbase:cron-origin:v1.${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

describe('request activity', () => {
  it('keeps a request classified as cron when its response finishes after token expiry', async () => {
    const now = 1_800_000_000_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + 899_000);
    app.get('/v1/:app_id/slow', async () => {
      vi.setSystemTime(now + 901_000);
      return { continued: verifyCronOrigin(cronOriginHeaders('app_demo')['x-butterbase-cron-origin'], 'app_demo') };
    });
    const response = await app.inject({ url: '/v1/app_demo/slow', headers: { 'x-butterbase-cron-origin': origin('app_demo', now / 1000) } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ continued: true });
    expect(mark).not.toHaveBeenCalled();
  });
  it.each(['/v1/app_demo/config', '/storage/app_demo/objects', '/v1/app_demo/status/404'])('does not refresh activity for signed cron traffic on %s', async (url) => {
    const response = await app.inject({ url, headers: { 'x-butterbase-cron-origin': origin() } });
    expect(response.statusCode).toBe(url.endsWith('/404') ? 404 : 200);
    expect(mark).not.toHaveBeenCalled();
  });
  it('does not refresh activity for signed subdomain cron traffic', async () => {
    await app.inject({ url: '/data', headers: { host: 'demo.example', 'x-butterbase-cron-origin': origin() } });
    expect(mark).not.toHaveBeenCalled();
  });
  it.each([
    { 'x-trigger-type': 'cron' },
    { 'x-butterbase-cron-origin': 'cron' },
    { 'x-butterbase-cron-origin': origin('app_other') },
    { 'x-butterbase-cron-origin': origin('app_demo', Math.floor(Date.now() / 1000) - 901) },
    { 'x-butterbase-cron-origin': origin('app_demo', Math.floor(Date.now() / 1000), 'wrong-secret') },
  ])('counts external traffic with an untrusted origin marker: %j', async (headers) => {
    await app.inject({ url: '/v1/app_demo/config', headers });
    expect(mark).toHaveBeenCalledOnce();
  });
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
