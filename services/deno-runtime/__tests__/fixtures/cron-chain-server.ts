// Test-only runtime: real executor and generated Workers, fixture metadata.
import { executeFunction } from '../../worker-executor.ts';

Deno.serve({ port: 7133, hostname: '0.0.0.0' }, async req => {
  const path = new URL(req.url).pathname;
  if (path === '/health') return new Response('ok');
  const [, , appId, name] = path.split('/');
  const code = name === 'parent'
    ? `const handler = async (_req, ctx) => ctx.invoke('child', { scheduled: true });`
    : `const handler = async (_req, ctx) => fetch(ctx.env.BUTTERBASE_API_URL + '/v1/' + ctx.app.id + '/config', { headers: { authorization: 'Bearer internal-test-key' } });`;
  const metadata = {
    id: 'fn_chain', app_id: appId, name, function_name: name, code,
    env_vars: {}, internal_fn_key: 'internal-test-key', timeout_ms: 10000,
    memory_limit_mb: 128, db_connection_string: null, substrate_organization_id: null,
    platform: { app_name: 'chain-test', owner_id: 'owner', region: 'local', subdomain: null,
      frontend_url: null, anon_key: 'anon_test', allowed_origins: [], stripe_connect_account_id: null,
      ai_default_model: null, jwt_access_token_ttl: null, jwt_refresh_token_ttl_days: null, auth_hook_function: null },
  } as any;
  const result = await executeFunction(metadata, req);
  if (!result.response) return Response.json(result, { status: 500 });
  return new Response(Uint8Array.from(atob(result.response.bodyBase64), c => c.charCodeAt(0)), { status: result.response.status, headers: result.response.headers });
});
