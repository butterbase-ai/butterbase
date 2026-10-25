import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { verifyCronOrigin } from '../cron-origin.ts';

const SECRET = 'runtime-cron-origin-test-secret';
Deno.env.set('BUTTERBASE_INTERNAL_SECRET', SECRET);
const hits: Array<{ path: string; token: string | null; auth: string | null; body: string }> = [];
let base = '';
let childMetadata: any;
const server = Deno.serve({ port: 0, hostname: '0.0.0.0', onListen() {} }, async req => {
  const url = new URL(req.url);
  hits.push({ path: url.pathname, token: req.headers.get('x-butterbase-cron-origin'), auth: req.headers.get('authorization'), body: await req.clone().text() });
  if (url.pathname.endsWith('/fn/child')) {
    const result = await executeFunction(childMetadata, req);
    if (!result.response) return new Response(JSON.stringify(result), { status: 500 });
    return new Response(Uint8Array.from(atob(result.response.bodyBase64), c => c.charCodeAt(0)), { status: result.response.status, headers: result.response.headers });
  }
  return Response.json({ ok: true, token: req.headers.get('x-butterbase-cron-origin') });
});
base = `http://127.0.0.1:${server.addr.port}`;
Deno.env.set('API_BASE_URL', base);
Deno.env.set('CONTROL_API_URL', base);
Deno.env.set('DO_INVOKER_URL', base);
Deno.env.set('DO_INVOKER_TOKEN', 'test-invoker-token');
const { executeFunction } = await import('../worker-executor.ts');

function origin(appId = 'app_demo', iat = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(JSON.stringify({ appId, iat, exp: iat + 900 })).toString('base64url');
  return `${payload}.${createHmac('sha256', SECRET).update(`butterbase:cron-origin:v1.${payload}`).digest('base64url')}`;
}
function metadata(code: string) {
  return {
    id: 'fn_cron_test', app_id: 'app_demo', name: 'parent', function_name: 'parent', code: code.replace('export default', 'const handler ='),
    env_vars: {}, internal_fn_key: 'internal-test-function-key', timeout_ms: 10000,
    memory_limit_mb: 128, db_connection_string: null, substrate_organization_id: null,
    platform: { app_name: 'cron-test', owner_id: 'owner', region: 'local', subdomain: null,
      frontend_url: null, anon_key: 'anon_test', allowed_origins: [], stripe_connect_account_id: null,
      ai_default_model: null, jwt_access_token_ttl: null, jwt_refresh_token_ttl_days: null, auth_hook_function: null },
  } as any;
}
async function run(code: string, token?: string, extraHeaders: Record<string, string> = {}, timeoutMs = 10000) {
  hits.length = 0;
  const headers = new Headers(extraHeaders);
  if (token) headers.set('x-butterbase-cron-origin', token);
  const fn = metadata(code); fn.timeout_ms = timeoutMs;
  const result = await executeFunction(fn, new Request(`${base}/execute/app_demo/parent`, { headers }));
  assert.equal(result.success, true, JSON.stringify(result));
  // The executor resolves before waitUntil cleanup terminates the worker.
  await new Promise(resolve => setTimeout(resolve, 30));
  return JSON.parse(atob(result.response!.bodyBase64));
}

Deno.test({ name: 'managed cron origin propagation', sanitizeOps: false, sanitizeResources: false, async fn(t) {
  try {
    await t.step('long executions and near-expiry descendants receive sufficient attested execution budgets', async () => {
      for (const [token, timeoutMs] of [[origin(), 1_200_000], [origin('app_demo', Math.floor(Date.now() / 1000) - 890), 10_000]] as const) {
        await run(`export default async (_req, ctx) => fetch(ctx.env.BUTTERBASE_API_URL + '/v1/app_demo/config');`, token, {}, timeoutMs);
        const outgoing = hits[0].token;
        assert.notEqual(outgoing, token);
        const future = Date.now() + (timeoutMs === 1_200_000 ? 1_234_000 : 899_000);
        assert.equal(verifyCronOrigin(outgoing, 'app_demo', SECRET, future), true);
      }
    });
    await t.step('raw fetch and Request calls carry origin without exposing it to the handler', async () => {
      const token = origin();
      const result = await run(`export default async (req, ctx) => {
        const url = ctx.env.BUTTERBASE_API_URL + '/v1/app_demo/config';
        await fetch(url, { method: 'POST', headers: { authorization: 'Bearer own-key' }, body: 'raw-body' });
        await fetch(new Request(url, { method: 'PUT', headers: { 'x-custom': 'yes' }, body: 'request-body' }));
        return Response.json({ exposed: req.headers.get('x-butterbase-cron-origin'), secret: Deno.env.get('BUTTERBASE_INTERNAL_SECRET') ?? null });
      }`, token);
      assert.deepEqual(result, { exposed: null, secret: null });
      assert.equal(hits.length, 2);
      assert.ok(hits.every(hit => hit.token === token));
      assert.equal(hits[0].auth, 'Bearer own-key');
      assert.deepEqual(hits.map(hit => hit.body), ['raw-body', 'request-body']);
    });
    await t.step('cron -> ctx.invoke -> raw API fetch keeps the original envelope', async () => {
      childMetadata = metadata(`export default async (_req, ctx) => {
        return fetch(ctx.env.BUTTERBASE_API_URL + '/v1/app_demo/config');
      }`);
      const token = origin();
      const result = await run(`export default async (_req, ctx) => ctx.invoke('child', { hello: true });`, token);
      assert.equal(result.token, token);
      assert.deepEqual(hits.map(hit => hit.path), ['/v1/app_demo/fn/child', '/v1/app_demo/config']);
      assert.ok(hits.every(hit => hit.token === token));
      assert.equal(hits[0].auth, 'Bearer internal-test-function-key');
    });
    await t.step('ctx.kv and ctx.invokeDO carry origin alongside existing authentication', async () => {
      const token = origin();
      await run(`export default async (_req, ctx) => {
        await ctx.kv.get('key');
        await ctx.invokeDO('room', 'one', { ping: true });
        return Response.json({ ok: true });
      }`, token);
      assert.ok(hits.every(hit => hit.token === token));
      assert.equal(hits[0].auth, 'Bearer internal-test-function-key');
      assert.equal(hits[1].auth, 'Bearer test-invoker-token');
    });
    await t.step('bare cron headers, wrong-app and missing origin do not propagate', async () => {
      for (const token of [undefined, 'cron', origin('app_other')]) {
        await run(`export default async (_req, ctx) => fetch(ctx.env.BUTTERBASE_API_URL + '/v1/app_demo/config');`, token, { 'x-trigger-type': 'cron' });
        assert.equal(hits[0].token, null);
      }
    });
  } finally { await server.shutdown(); }
} });
