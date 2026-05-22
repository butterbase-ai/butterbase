import type { Env } from './worker.js';

export interface ResolvedApp {
  appId: string;
  region: string;
  redisPassword: string;
}

export interface ResolveDeps {
  apiKey: string;
  env: Env;
  fetch?: typeof fetch;
}

export async function resolveApp(deps: ResolveDeps): Promise<ResolvedApp | null> {
  const f = deps.fetch ?? fetch;
  const res = await f(`${deps.env.CONTROL_API_URL}/v1/internal/kv/resolve-key`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': deps.env.INTERNAL_SECRET,
    },
    body: JSON.stringify({ api_key: deps.apiKey }),
  });
  if (res.status !== 200) return null;
  const j = (await res.json()) as { app_id: string; region: string; redis_password: string };
  return { appId: j.app_id, region: j.region, redisPassword: j.redis_password };
}
