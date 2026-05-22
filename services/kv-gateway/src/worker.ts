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

function parseRoute(pathname: string): { appId: string; key?: string; action?: string } | null {
  // /v1/{app}/kv/_batch
  let m = /^\/v1\/([^/]+)\/kv\/_batch$/.exec(pathname);
  if (m) return { appId: m[1], action: '_batch' };
  // /v1/{app}/kv/:key/:action
  m = /^\/v1\/([^/]+)\/kv\/(.+)\/(incr|decr|setnx|cas|expire|ttl|exists)$/.exec(pathname);
  if (m) return { appId: m[1], key: m[2], action: m[3] };
  // /v1/{app}/kv/:key
  m = /^\/v1\/([^/]+)\/kv\/(.+)$/.exec(pathname);
  if (m) return { appId: m[1], key: m[2] };
  return null;
}

// CAS Lua script uses the sentinel '__NULL__' to represent an absent/null expected value.
// Caveat: user values that JSON-encode to the string "__NULL__" (i.e. the JSON string `"__NULL__"`)
// would be indistinguishable from the null sentinel. This is a known, documented limitation.
const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if (current == false and ARGV[1] == '__NULL__') or current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0
`.trim();

// Maximum batch size — keeps latency bounded and prevents runaway memory use.
const BATCH_MAX_OPS = 100;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ status: 'ok' });

    const route = parseRoute(url.pathname);
    if (!route) return err('not_found', 404);
    const { appId: pathAppId, key, action } = route;

    const auth = req.headers.get('authorization');
    if (!auth?.startsWith('Bearer ')) return err('unauthorized', 401);
    const apiKey = auth.slice(7).trim();

    const resolved = await resolveApp({ apiKey, appId: pathAppId, env });
    if (!resolved) return err('unauthorized', 401);
    // Defensive: the contract guarantees app_id match, but keep the check.
    if (resolved.appId !== pathAppId) return err('forbidden', 403, 'app_id mismatch');

    // For non-batch routes, validate the key now.
    if (action !== '_batch') {
      if (!key || !isValidUserKey(key)) return err('key_invalid', 400);
    }

    const endpoint = pickRedisEndpoint(env, resolved.region);
    const client = await RedisClient.connect({
      host: endpoint.host,
      port: endpoint.port,
      password: resolved.redisPassword,
    });

    try {
      // ── batch ──────────────────────────────────────────────────────────────
      if (action === '_batch') {
        if (req.method !== 'POST') return err('method_not_allowed', 405);
        const body = (await req.json()) as { ops?: unknown[] };
        if (!Array.isArray(body.ops)) return err('bad_request', 400, 'ops must be an array');
        if (body.ops.length > BATCH_MAX_OPS) {
          return err('bad_request', 400, `batch limited to ${BATCH_MAX_OPS} ops`);
        }
        const results: unknown[] = [];
        for (const op of body.ops as Array<{ op?: unknown; key?: unknown; value?: unknown }>) {
          if (typeof op.op !== 'string' || !['get', 'set', 'del'].includes(op.op)) {
            results.push({ error: 'invalid op' });
            continue;
          }
          if (typeof op.key !== 'string' || !isValidUserKey(op.key)) {
            results.push({ error: 'key_invalid' });
            continue;
          }
          const fk = userKey(resolved.appId, op.key);
          if (op.op === 'get') {
            const v = await client.get(fk);
            results.push({ value: v === null ? null : JSON.parse(v) });
          } else if (op.op === 'set') {
            await client.set(fk, JSON.stringify(op.value));
            results.push({ ok: true });
          } else if (op.op === 'del') {
            const count = await client.del([fk]);
            results.push({ deleted: count });
          }
        }
        return json({ results });
      }

      // All remaining routes have a validated `key`; build the full Redis key.
      const fullKey = userKey(resolved.appId, key!);

      // ── action routes ──────────────────────────────────────────────────────
      if (action === 'incr') {
        if (req.method !== 'POST') return err('method_not_allowed', 405);
        const body = (await req.json().catch(() => ({}))) as { by?: number };
        const by = typeof body.by === 'number' ? body.by : 1;
        const value = await client.incrBy(fullKey, by);
        return json({ value });
      }

      if (action === 'decr') {
        if (req.method !== 'POST') return err('method_not_allowed', 405);
        const body = (await req.json().catch(() => ({}))) as { by?: number };
        const by = typeof body.by === 'number' ? body.by : 1;
        const value = await client.decrBy(fullKey, by);
        return json({ value });
      }

      if (action === 'setnx') {
        if (req.method !== 'POST') return err('method_not_allowed', 405);
        const body = (await req.json()) as { value: unknown };
        if (!('value' in body)) return err('bad_request', 400, 'missing value');
        const wrote = await client.setnx(fullKey, JSON.stringify(body.value));
        return json({ wrote }, wrote ? 201 : 200);
      }

      if (action === 'cas') {
        if (req.method !== 'POST') return err('method_not_allowed', 405);
        const body = (await req.json()) as { expected: unknown; next: unknown };
        if (!('expected' in body) || !('next' in body)) {
          return err('bad_request', 400, 'missing expected or next');
        }
        const expectedArg = body.expected === null ? '__NULL__' : JSON.stringify(body.expected);
        const r = await client.eval(CAS_SCRIPT, [fullKey], [expectedArg, JSON.stringify(body.next)]);
        return json({ swapped: r === 1 });
      }

      if (action === 'expire') {
        if (req.method !== 'POST') return err('method_not_allowed', 405);
        const body = (await req.json()) as { ttl: number | null };
        if (!('ttl' in body)) return err('bad_request', 400, 'missing ttl');
        const ok = await client.expire(fullKey, body.ttl);
        return json({ ok });
      }

      if (action === 'ttl') {
        if (req.method !== 'GET') return err('method_not_allowed', 405);
        const t = await client.ttl(fullKey);
        if (t === -2) return err('not_found', 404); // key does not exist
        return json({ ttl: t === -1 ? null : t });
      }

      if (action === 'exists') {
        if (req.method !== 'GET') return err('method_not_allowed', 405);
        const exists = await client.exists(fullKey);
        return json({ exists });
      }

      // ── base CRUD ──────────────────────────────────────────────────────────
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
