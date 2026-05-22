import { resolveApp } from './auth.js';
import { RedisClient } from './redis-client.js';
import { userKey, isValidUserKey } from './keys.js';

export interface Env {
  CONTROL_API_URL: string;
  REDIS_HOST_US: string;
  REDIS_HOST_EU: string;
  REDIS_PORT: string;
  REDIS_PORT_US?: string;
  REDIS_PORT_EU?: string;
  INTERNAL_SECRET: string;
}

const ROUTE_RE = /^\/v1\/([^/]+)\/kv\/(.+)$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function err(code: string, status: number, message?: string): Response {
  return json({ error: code, message: message ?? code }, status);
}

function pickRedisEndpoint(env: Env, region: string): { host: string; port: number } {
  if (region === 'us') {
    return { host: env.REDIS_HOST_US, port: Number(env.REDIS_PORT_US ?? env.REDIS_PORT) };
  }
  if (region === 'eu') {
    return { host: env.REDIS_HOST_EU, port: Number(env.REDIS_PORT_EU ?? env.REDIS_PORT) };
  }
  throw new Error(`unknown region: ${region}`);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ status: 'ok' });

    const m = ROUTE_RE.exec(url.pathname);
    if (!m) return err('not_found', 404);
    const [, pathAppId, key] = m;

    const auth = req.headers.get('authorization');
    if (!auth?.startsWith('Bearer ')) return err('unauthorized', 401);
    const apiKey = auth.slice(7).trim();

    const resolved = await resolveApp({ apiKey, appId: pathAppId, env });
    if (!resolved) return err('unauthorized', 401);
    // Defensive: the contract guarantees app_id match, but keep the check.
    if (resolved.appId !== pathAppId) return err('forbidden', 403, 'app_id mismatch');

    if (!isValidUserKey(key)) return err('key_invalid', 400);

    const fullKey = userKey(resolved.appId, key);
    const endpoint = pickRedisEndpoint(env, resolved.region);
    const client = await RedisClient.connect({
      host: endpoint.host,
      port: endpoint.port,
      password: resolved.redisPassword,
    });

    try {
      if (req.method === 'GET') {
        const v = await client.get(fullKey);
        if (v === null) return err('not_found', 404);
        return json({ value: JSON.parse(v) });
      }
      if (req.method === 'PUT') {
        const body = (await req.json()) as { value: unknown };
        if (!('value' in body)) return err('bad_request', 400, 'missing value');
        await client.set(fullKey, JSON.stringify(body.value));
        return new Response(null, { status: 204 });
      }
      if (req.method === 'DELETE') {
        await client.del([fullKey]);
        return new Response(null, { status: 204 });
      }
      return err('method_not_allowed', 405);
    } finally {
      await client.close();
    }
  },
};
