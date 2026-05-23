import { resolveApp } from './auth.js';
import { RedisClient, RedisClientOptions } from './redis-client.js';
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

// Default TTL for all writes unless overridden.
const DEFAULT_TTL_SECONDS = 30 * 24 * 3600; // 30 days

// Logical DB indices. DB 0 is durable (persisted), DB 1 is ephemeral (shorter-lived).
// Reads use durable-first fanout: DB 0 → DB 1 on miss. This avoids the complexity of
// marker keys while keeping ephemeral routing transparent to callers.
const DURABLE_DB = 0;
const EPHEMERAL_DB = 1;

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

// Maximum value size in bytes (256 KB hard cap at the gateway).
const MAX_VALUE_BYTES = 256 * 1024;

// Check if a JSON-encoded value exceeds the maximum size.
// Returns an error Response if oversized, null otherwise.
function checkValueSize(encoded: string): Response | null {
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > MAX_VALUE_BYTES) {
    return err('KV_VALUE_TOO_LARGE', 413, `value exceeds ${MAX_VALUE_BYTES} bytes`);
  }
  return null;
}

// After writing a key to one DB, remove any stale copy from the other DB.
// This prevents durable-first GET fanout from returning a stale value when the
// caller switches a key between ephemeral and durable (or vice versa).
// Best-effort: errors are swallowed so the original write is never reported as failed.
async function deleteFromOtherDb(baseOpts: Omit<RedisClientOptions, 'db'>, writtenDb: number, fullKey: string): Promise<void> {
  const otherDb = writtenDb === DURABLE_DB ? EPHEMERAL_DB : DURABLE_DB;
  try {
    await withRedis(baseOpts, otherDb, (c) => c.del([fullKey]));
  } catch (e) {
    console.warn('[kv-gateway] cross-db cleanup failed (swallowed):', (e as any)?.message ?? e);
  }
}

// Helper: open a RedisClient connection to the given DB, run fn, and close on all paths.
async function withRedis<T>(
  baseOpts: Omit<RedisClientOptions, 'db'>,
  db: number,
  fn: (c: RedisClient) => Promise<T>,
): Promise<T> {
  const c = await RedisClient.connect({ ...baseOpts, db });
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}

// Sidecar key for touch-on-read TTL capture. Uses the same hash-tag scheme as userKey
// ({appId}) so both keys land in the same hash slot. The _ttl: namespace is reserved
// (isValidUserKey rejects keys starting with '_'), so no user key can collide.
function sidecarTtlKey(appId: string, userKeyValue: string): string {
  return `{${appId}}:_ttl:${userKeyValue}`;
}

// Resolve and validate the ttl field from a PUT/setnx body.
// Returns { ok: true, ttl: number | null } or { ok: false, response: Response }.
function resolveTtl(rawTtl: unknown): { ok: true; ttl: number | null } | { ok: false; response: Response } {
  if (rawTtl === undefined) {
    // Not specified → use default TTL.
    return { ok: true, ttl: DEFAULT_TTL_SECONDS };
  }
  if (rawTtl === null) {
    // Explicit null → no expiry (persist forever).
    return { ok: true, ttl: null };
  }
  if (typeof rawTtl !== 'number' || !Number.isInteger(rawTtl) || rawTtl <= 0) {
    return { ok: false, response: err('bad_request', 400, 'ttl must be a positive integer or null') };
  }
  return { ok: true, ttl: rawTtl };
}

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
    const baseOpts: Omit<RedisClientOptions, 'db'> = {
      host: endpoint.host,
      port: endpoint.port,
      password: resolved.redisPassword,
    };

    // ── batch ──────────────────────────────────────────────────────────────────
    // _batch ops run on DURABLE_DB (DB 0) only. Ephemeral routing for individual
    // batch ops is not supported — batches are inherently durable-store operations.
    if (action === '_batch') {
      if (req.method !== 'POST') return err('method_not_allowed', 405);
      const body = (await req.json()) as { ops?: unknown[] };
      if (!Array.isArray(body.ops)) return err('bad_request', 400, 'ops must be an array');
      if (body.ops.length > BATCH_MAX_OPS) {
        return err('bad_request', 400, `batch limited to ${BATCH_MAX_OPS} ops`);
      }
      return withRedis(baseOpts, DURABLE_DB, async (client) => {
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
          try {
            if (op.op === 'get') {
              const v = await client.get(fk);
              results.push({ value: v === null ? null : JSON.parse(v) });
            } else if (op.op === 'set') {
              if (!('value' in op)) {
                results.push({ error: 'missing value' });
                continue;
              }
              const encoded = JSON.stringify(op.value);
              const sizeErr = checkValueSize(encoded);
              if (sizeErr) {
                results.push({ error: 'KV_VALUE_TOO_LARGE' });
                continue;
              }
              await client.set(fk, encoded);
              results.push({ ok: true });
            } else if (op.op === 'del') {
              const count = await client.del([fk]);
              results.push({ deleted: count });
            }
          } catch (e) {
            results.push({ error: 'redis_error', message: (e as any)?.message ?? 'unknown error' });
          }
        }
        return json({ results });
      });
    }

    // All remaining routes have a validated `key`; build the full Redis key.
    const fullKey = userKey(resolved.appId, key!);

    // ── action routes ──────────────────────────────────────────────────────────

    // incr/decr: always durable (atomic counters only make sense on DB 0)
    if (action === 'incr') {
      if (req.method !== 'POST') return err('method_not_allowed', 405);
      const body = (await req.json().catch(() => ({}))) as { by?: number };
      const by = typeof body.by === 'number' ? body.by : 1;
      if (!Number.isInteger(by)) return err('bad_request', 400, 'by must be an integer');
      return withRedis(baseOpts, DURABLE_DB, (c) => c.incrBy(fullKey, by).then((value) => json({ value })));
    }

    if (action === 'decr') {
      if (req.method !== 'POST') return err('method_not_allowed', 405);
      const body = (await req.json().catch(() => ({}))) as { by?: number };
      const by = typeof body.by === 'number' ? body.by : 1;
      if (!Number.isInteger(by)) return err('bad_request', 400, 'by must be an integer');
      return withRedis(baseOpts, DURABLE_DB, (c) => c.decrBy(fullKey, by).then((value) => json({ value })));
    }

    // setnx: honors ephemeral:true and ttl like PUT.
    if (action === 'setnx') {
      if (req.method !== 'POST') return err('method_not_allowed', 405);
      const body = (await req.json()) as { value: unknown; ttl?: number | null; ephemeral?: boolean };
      if (!('value' in body)) return err('bad_request', 400, 'missing value');
      const ttlResult = resolveTtl(body.ttl);
      if (!ttlResult.ok) return ttlResult.response;
      const resolvedTtl = ttlResult.ttl;
      const db = body.ephemeral === true ? EPHEMERAL_DB : DURABLE_DB;
      const encoded = JSON.stringify(body.value);
      const sizeErr = checkValueSize(encoded);
      if (sizeErr) return sizeErr;
      const wrote = await withRedis(baseOpts, db, async (c) => {
        // Use setWithOptions to combine NX + EX in one round trip.
        return c.setWithOptions(fullKey, encoded, {
          ex: resolvedTtl !== null ? resolvedTtl : undefined,
          nx: true,
        });
      });
      // Only clean up the other DB if we actually wrote — if setnx didn't write
      // (key already exists in chosen DB), we leave the existing value untouched.
      if (wrote) await deleteFromOtherDb(baseOpts, db, fullKey);
      return json({ wrote }, wrote ? 201 : 200);
    }

    // cas: always durable (atomic CAS only makes sense on DB 0)
    if (action === 'cas') {
      if (req.method !== 'POST') return err('method_not_allowed', 405);
      const body = (await req.json()) as { expected: unknown; next: unknown };
      if (!('expected' in body) || !('next' in body)) {
        return err('bad_request', 400, 'missing expected or next');
      }
      const expectedArg = body.expected === null ? '__NULL__' : JSON.stringify(body.expected);
      const nextArg = JSON.stringify(body.next);
      const sizeErr = checkValueSize(nextArg);
      if (sizeErr) return sizeErr;
      return withRedis(baseOpts, DURABLE_DB, async (c) => {
        const r = await c.eval(CAS_SCRIPT, [fullKey], [expectedArg, nextArg]);
        return json({ swapped: r === 1 });
      });
    }

    // expire: always durable (TTL management for durable keys only)
    if (action === 'expire') {
      if (req.method !== 'POST') return err('method_not_allowed', 405);
      const body = (await req.json()) as { ttl: number | null };
      if (!('ttl' in body)) return err('bad_request', 400, 'missing ttl');
      const ttl = body.ttl;
      if (ttl !== null && (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 0)) {
        return err('bad_request', 400, 'ttl must be a non-negative integer or null');
      }
      return withRedis(baseOpts, DURABLE_DB, async (c) => {
        const ok = await c.expire(fullKey, ttl);
        return json({ ok });
      });
    }

    // ttl: durable-first fanout — try DB 0; if missing (-2), try DB 1.
    if (action === 'ttl') {
      if (req.method !== 'GET') return err('method_not_allowed', 405);
      let t = await withRedis(baseOpts, DURABLE_DB, (c) => c.ttl(fullKey));
      if (t === -2) {
        t = await withRedis(baseOpts, EPHEMERAL_DB, (c) => c.ttl(fullKey));
      }
      if (t === -2) return err('not_found', 404); // key does not exist in either DB
      return json({ ttl: t === -1 ? null : t });
    }

    // exists: durable-first — return true if either DB has the key.
    if (action === 'exists') {
      if (req.method !== 'GET') return err('method_not_allowed', 405);
      const existsDurable = await withRedis(baseOpts, DURABLE_DB, (c) => c.exists(fullKey));
      if (existsDurable) return json({ exists: true });
      const existsEphemeral = await withRedis(baseOpts, EPHEMERAL_DB, (c) => c.exists(fullKey));
      return json({ exists: existsEphemeral });
    }

    // ── base CRUD ──────────────────────────────────────────────────────────────

    if (req.method === 'GET') {
      const touch = url.searchParams.get('touch') === 'true';

      // Durable-first fanout: try DB 0, then DB 1 on miss.
      // Track which DB the value came from so touch can gate on durable-only.
      let foundIn: number | null = null;
      let v: string | null = null;
      await withRedis(baseOpts, DURABLE_DB, async (c) => {
        v = await c.get(fullKey);
        if (v !== null) foundIn = DURABLE_DB;
      });
      if (v === null) {
        await withRedis(baseOpts, EPHEMERAL_DB, async (c) => {
          v = await c.get(fullKey);
          if (v !== null) foundIn = EPHEMERAL_DB;
        });
      }
      if (v === null) return err('not_found', 404);

      // Touch-on-read: only for durable hits. Ephemeral keys are allowed to expire.
      if (touch && foundIn === DURABLE_DB) {
        try {
          await withRedis(baseOpts, DURABLE_DB, async (c) => {
            const sidecarKey = sidecarTtlKey(resolved.appId, key!);
            const stored = await c.get(sidecarKey);
            let originalTtl: number | null = stored !== null ? Number(stored) : null;
            if (originalTtl === null) {
              const cur = await c.ttl(fullKey);
              if (cur > 0) {
                originalTtl = cur;
                await c.setex(sidecarKey, cur * 2, String(cur));
              }
            }
            if (originalTtl !== null && originalTtl > 0) {
              await c.expire(fullKey, originalTtl);
            }
          });
        } catch (e) {
          console.warn('[kv-gateway] touch failed (swallowed):', (e as any)?.message ?? e);
        }
      }

      return json({ value: JSON.parse(v) });
    }

    if (req.method === 'PUT') {
      const body = (await req.json()) as { value: unknown; ttl?: number | null; ephemeral?: boolean };
      if (!('value' in body)) return err('bad_request', 400, 'missing value');
      const ttlResult = resolveTtl(body.ttl);
      if (!ttlResult.ok) return ttlResult.response;
      const resolvedTtl = ttlResult.ttl;
      const db = body.ephemeral === true ? EPHEMERAL_DB : DURABLE_DB;
      const encoded = JSON.stringify(body.value);
      const sizeErr = checkValueSize(encoded);
      if (sizeErr) return sizeErr;
      await withRedis(baseOpts, db, async (c) => {
        if (resolvedTtl === null) {
          await c.set(fullKey, encoded);
        } else {
          await c.setex(fullKey, resolvedTtl, encoded);
        }
      });
      await deleteFromOtherDb(baseOpts, db, fullKey);
      return new Response(null, { status: 204 });
    }

    if (req.method === 'DELETE') {
      // Delete from BOTH DBs and return the actual total count so callers can
      // distinguish "key existed" from "key was already gone".
      const delDur = await withRedis(baseOpts, DURABLE_DB, (c) => c.del([fullKey]));
      const delEph = await withRedis(baseOpts, EPHEMERAL_DB, (c) => c.del([fullKey]));
      return json({ deleted: delDur + delEph });
    }

    return err('method_not_allowed', 405);
  },
};
