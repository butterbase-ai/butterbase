import type { Env } from './worker.js';

export interface ResolvedApp {
  appId: string;
  region: string;
  redisPassword: string;
}

export interface ResolveDeps {
  apiKey: string;
  appId: string;
  env: Env;
  fetch?: typeof fetch;
}

export async function resolveApp(deps: ResolveDeps): Promise<ResolvedApp | null> {
  const f = deps.fetch ?? fetch;
  const res = await f(`${deps.env.CONTROL_API_URL}/v1/internal/kv/resolve-key`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-butterbase-internal-secret': deps.env.INTERNAL_SECRET,
    },
    body: JSON.stringify({ api_key: deps.apiKey, app_id: deps.appId }),
  });
  // All non-200 responses from control-api flatten to null here, and the gateway
  // always returns 401 to the caller — including the case where the API key is
  // valid but the user doesn't own the requested app (control-api returns 403).
  // This is intentional: leaking 403-vs-401 would let an attacker enumerate which
  // app_ids exist under a stolen key.
  if (res.status !== 200) return null;
  const j = (await res.json()) as { app_id: string; region: string; redis_password: string };
  return { appId: j.app_id, region: j.region, redisPassword: j.redis_password };
}
