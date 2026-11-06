import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCronFetch as createDenoCronFetch } from '../../../deno-runtime/cron-fetch.ts';
import { createCronFetch as createDoCronFetch } from './cron-fetch.js';
import { nativeFetch } from '../../test/native-fetch.js';

let server: Server;
let base: string;
let external: Server;
let outside: string;
const seen: Array<{ url: string; token: string | undefined; method: string; auth: string | undefined; body: string }> = [];
beforeAll(async () => {
  const handler: Parameters<typeof createServer>[0] = async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url!, token: req.headers['x-butterbase-cron-origin'] as string | undefined, method: req.method!, auth: req.headers.authorization, body });
    if (req.url === '/redirect') { res.writeHead(307, { location: '/target' }); res.end(); }
    else if (req.url === '/get') { res.writeHead(303, { location: '/target' }); res.end(); }
    else if (req.url === '/outside') { res.writeHead(302, { location: outside + '/target' }); res.end(); }
    else if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); }
  };
  server = createServer(handler); external = createServer(handler);
  await Promise.all([new Promise<void>(r => server.listen(0, '127.0.0.1', r)), new Promise<void>(r => external.listen(0, '127.0.0.1', r))]);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  outside = `http://127.0.0.1:${(external.address() as any).port}`;
});
afterAll(async () => { await Promise.all([new Promise(r => server.close(r)), new Promise(r => external.close(r))]); });

describe.each([['Deno', createDenoCronFetch], ['DO', createDoCronFetch]] as const)('%s cron fetch HTTP behavior', (_name, createCronFetch) => {
  it('tags configured origins and preserves Request body, init headers and auth', async () => {
    seen.length = 0;
    const cronFetch = createCronFetch(nativeFetch, 'signed-origin', [base]);
    const response = await cronFetch(new Request(base + '/target', { method: 'POST', body: 'payload' }), { headers: new Headers({ authorization: 'Bearer app-key' }) });
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ url: '/target', token: 'signed-origin', method: 'POST', auth: 'Bearer app-key', body: 'payload' }]);
  });
  it('does not tag external origins, including lookalikes', async () => {
    seen.length = 0;
    const cronFetch = createCronFetch(nativeFetch, 'signed-origin', [base + '/']);
    await cronFetch(outside + '/target');
    expect(seen[0].token).toBeUndefined();
  });
  it('keeps origin and POST body across 307 redirects', async () => {
    seen.length = 0;
    const response = await createCronFetch(nativeFetch, 'signed-origin', [base])(base + '/redirect', { method: 'POST', body: 'payload' });
    expect(response.redirected).toBe(true);
    expect(response.url).toBe(base + '/target');
    expect(seen.map(r => [r.method, r.body, r.token])).toEqual([['POST', 'payload', 'signed-origin'], ['POST', 'payload', 'signed-origin']]);
  });
  it('switches to GET for 303 redirects', async () => {
    seen.length = 0;
    await createCronFetch(nativeFetch, 'signed-origin', [base])(base + '/get', { method: 'PUT', body: 'payload' });
    expect(seen.map(r => [r.method, r.body])).toEqual([['PUT', 'payload'], ['GET', '']]);
  });
  it('strips provenance and authentication before following external redirects', async () => {
    seen.length = 0;
    await createCronFetch(nativeFetch, 'signed-origin', [base])(base + '/outside', { headers: { authorization: 'Bearer app-key' } });
    expect(seen.map(r => [r.token, r.auth])).toEqual([['signed-origin', 'Bearer app-key'], [undefined, undefined]]);
  });
  it('respects manual and error redirect modes', async () => {
    const cronFetch = createCronFetch(nativeFetch, 'signed-origin', [base]);
    expect((await cronFetch(base + '/redirect', { redirect: 'manual' })).status).toBe(307);
    await expect(cronFetch(base + '/redirect', { redirect: 'error' })).rejects.toThrow();
    await expect(cronFetch(base + '/loop')).rejects.toThrow();
  });
  it('preserves aborted signals', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createCronFetch(nativeFetch, 'signed-origin', [base])(base, { signal: controller.signal })).rejects.toThrow();
  });
});
