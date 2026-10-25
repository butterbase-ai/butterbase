import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { buildBundle } from './do-bundler.js';
import { nativeFetch } from '../../test/native-fetch.js';

it('strips DO cron origin and auth on external redirects while preserving redirect method/body behavior', async () => {
  const seen: Array<{ path: string; method: string; body: string; origin: string | null; auth: string | null }> = [];
  const external = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ path: req.url!, method: req.method!, body, origin: req.headers['x-butterbase-cron-origin'] as string ?? null, auth: req.headers.authorization ?? null });
    res.end('ok');
  });
  await new Promise<void>(r => external.listen(0, '127.0.0.1', r));
  const outside = `http://127.0.0.1:${(external.address() as any).port}`;
  const api = createServer((req, res) => { res.writeHead(req.url === '/invoke' ? 307 : 302, { location: outside + req.url }); res.end(); });
  await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.address() as any).port}`;
  try {
    const { bundle } = buildBundle([{ name: 'room', code: 'export class Room {}', access_mode: 'public' }]);
    const helper = new Function('fetch', bundle.replace(/export class /g, 'class ').replace('export default {', 'const worker = {') + '\nreturn butterbase;')(nativeFetch);
    const ctx = helper.ctx(new Request('https://internal.butterbase/_dispatch/room/one', { headers: { 'x-butterbase-cron-origin': 'signed-origin' } }),
      { BUTTERBASE_APP_ID: 'app_demo', BUTTERBASE_API_URL: base, DO_INVOKER_URL: base, DO_INVOKER_TOKEN: 'invoker-key', BUTTERBASE_INTERNAL_FN_KEY: 'function-key' }, {});
    expect((await ctx.invoke('child', { hello: true })).status).toBe(200);
    expect((await ctx.invokeDO('room', 'two', { hello: true })).status).toBe(200);
    expect(seen).toEqual([
      { path: '/v1/app_demo/fn/child', method: 'GET', body: '', origin: null, auth: null },
      { path: '/invoke', method: 'POST', body: '{"hello":true}', origin: null, auth: null },
    ]);
  } finally { await Promise.all([new Promise(r => api.close(r)), new Promise(r => external.close(r))]); }
});
