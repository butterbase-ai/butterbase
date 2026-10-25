import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { signCronOrigin } from './cron-origin.js';
import activityPlugin from '../plugins/app-activity.js';
import { invokeFunction } from './function-invoke.js';
import { nativeFetch } from '../../test/native-fetch.js';

const config = vi.hoisted(() => ({ runtimeUrl: '' }));
vi.mock('../config.js', () => ({ config }));
vi.mock('./app-activity.js', () => ({ markAppActive: async () => {} }));
let server: Server;
let previousFetch: typeof fetch;
beforeAll(async () => {
  previousFetch = globalThis.fetch;
  globalThis.fetch = nativeFetch;
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ token: req.headers['x-butterbase-cron-origin'] ?? null, user: req.headers['x-user-id'] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  config.runtimeUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { globalThis.fetch = previousFetch; await new Promise(r => server.close(r)); });
afterEach(() => vi.unstubAllEnvs());

it('keeps cron origin when platform code invokes a downstream function and preserves caller auth', async () => {
  vi.stubEnv('BUTTERBASE_INTERNAL_SECRET', 'dispatch-test-secret');
  const app = Fastify(); app.decorate('controlDb', {} as never);
  await app.register(activityPlugin);
  app.get('/v1/:app_id/trigger', async () => invokeFunction({ appId: 'app_demo', functionName: 'hook', args: {}, callerKind: 'function', callerUserId: 'user_one' }));
  try {
    const token = signCronOrigin('app_demo');
    const scheduled = await app.inject({ url: '/v1/app_demo/trigger', headers: { 'x-butterbase-cron-origin': token } });
    expect(scheduled.json().result).toEqual({ token, user: 'user_one' });
    const external = await app.inject('/v1/app_demo/trigger');
    expect(external.json().result).toEqual({ token: null, user: 'user_one' });
  } finally { await app.close(); }
});
