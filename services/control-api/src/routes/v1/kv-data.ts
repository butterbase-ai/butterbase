/**
 * kv-data.ts — Fastify plugin for KV data-plane routes.
 *
 * Ported verbatim from kv-gateway/src/worker.ts, replacing Worker fetch()
 * primitives with Fastify route handlers. Behavior is identical.
 *
 * Routes handled:
 *   GET    /v1/:app_id/kv/:key           → {value, ttl?} or 404
 *   PUT    /v1/:app_id/kv/:key           → 204
 *   DELETE /v1/:app_id/kv/:key           → {deleted: N}
 *   POST   /v1/:app_id/kv/_batch         → {results: [...]}
 *   POST   /v1/:app_id/kv/:key/incr      → {value}
 *   POST   /v1/:app_id/kv/:key/decr      → {value}
 *   POST   /v1/:app_id/kv/:key/setnx     → {wrote: bool}
 *   POST   /v1/:app_id/kv/:key/cas       → {swapped: bool}
 *   POST   /v1/:app_id/kv/:key/expire    → {applied: bool}
 *   GET    /v1/:app_id/kv/:key/ttl       → {ttl: number|null}
 *   GET    /v1/:app_id/kv/:key/exists    → {exists: bool}
 */

import type { FastifyPluginAsync } from 'fastify';
import { resolveKvAuth } from '../../services/kv/auth.js';
import { RedisClient, type RedisClientOptions } from '../../services/kv/redis-client.js';
import { userKey, isValidUserKey } from '../../services/kv/keys.js';
import {
  loadRules,
  substituteAndTest,
  type CompiledRule,
} from '../../services/kv/expose.js';

// ── Constants (must match kv-gateway/src/worker.ts) ───────────────────────────

const DEFAULT_TTL_SECONDS = 30 * 24 * 3600; // 30 days
const DURABLE_DB = 0;
const EPHEMERAL_DB = 1;
const BATCH_MAX_OPS = 100;
const MAX_VALUE_BYTES = 256 * 1024;

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

// ── Connection helpers ─────────────────────────────────────────────────────────

/**
 * Derive RedisClientOptions for a region from environment variables.
 * KV_REDIS_URL_<REGION> must be set (e.g. KV_REDIS_URL_US=redis://:pass@host:port).
 */
function baseOptsForRegion(region: string, password: string): Omit<RedisClientOptions, 'db'> {
  const envKey = `KV_REDIS_URL_${region.toUpperCase().replace(/-/g, '_')}`;
  const url = process.env[envKey];
  if (!url) throw new Error(`Missing environment variable: ${envKey}`);
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 6379,
    password: u.password || password,
  };
}

// Open a short-lived RedisClient for a specific DB, run fn, always close.
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

// After writing a key to one DB, remove any stale copy from the other DB.
async function deleteFromOtherDb(
  baseOpts: Omit<RedisClientOptions, 'db'>,
  writtenDb: number,
  fullKey: string,
): Promise<void> {
  const otherDb = writtenDb === DURABLE_DB ? EPHEMERAL_DB : DURABLE_DB;
  try {
    await withRedis(baseOpts, otherDb, (c) => c.del([fullKey]));
  } catch (e) {
    // Best-effort; swallowed so the original write is never reported as failed.
    console.warn('[kv-data] cross-db cleanup failed (swallowed):', (e as any)?.message ?? e);
  }
}

function sidecarTtlKey(appId: string, userKeyValue: string): string {
  return `{${appId}}:_ttl:${userKeyValue}`;
}

// ── Response helpers ───────────────────────────────────────────────────────────

function errBody(code: string, message?: string): Record<string, string> {
  return { error: code, message: message ?? code };
}

function checkValueSize(encoded: string): string | null {
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > MAX_VALUE_BYTES) return `value exceeds ${MAX_VALUE_BYTES} bytes`;
  return null;
}

function resolveTtl(
  rawTtl: unknown,
): { ok: true; ttl: number | null } | { ok: false; error: string; message: string } {
  if (rawTtl === undefined) return { ok: true, ttl: DEFAULT_TTL_SECONDS };
  if (rawTtl === null) return { ok: true, ttl: null };
  if (typeof rawTtl !== 'number' || !Number.isInteger(rawTtl) || rawTtl <= 0) {
    return { ok: false, error: 'bad_request', message: 'ttl must be a positive integer or null' };
  }
  return { ok: true, ttl: rawTtl };
}

// ── Expose enforcement (ported from worker.ts) ────────────────────────────────

type RequiredAction = 'read' | 'write';

function enforceExposeAccess(
  rules: CompiledRule[],
  key: string,
  required: RequiredAction,
  claims: { 'user.id'?: string; 'user.role'?: string } | null,
): { error: string; status: number } | null {
  const matched: CompiledRule[] = [];
  for (const r of rules) {
    if (claims && (r.read === 'owner' || r.write === 'owner')) {
      if (substituteAndTest(r, key, claims as Record<string, string>)) matched.push(r);
    } else {
      if (r.regex.test(key)) matched.push(r);
    }
  }
  if (matched.length === 0) {
    return claims
      ? { error: 'forbidden', status: 403 }
      : { error: 'unauthorized', status: 401 };
  }
  matched.sort(
    (a, b) =>
      b.literalPrefixLen - a.literalPrefixLen || a.declarationOrder - b.declarationOrder,
  );
  const winner = matched[0];
  const role = required === 'read' ? winner.read : winner.write;

  if (role === 'deny') {
    return claims
      ? { error: 'forbidden', status: 403 }
      : { error: 'unauthorized', status: 401 };
  }
  if (role === 'public') return null;
  if (!claims) return { error: 'unauthorized', status: 401 };
  if (role === 'authed' || role === 'owner') return null;
  return { error: 'forbidden', status: 403 };
}

// Build claims object from auth identity (jwt only; anon returns null).
function claimsFromAuth(
  identity: { kind: string; userId?: string; role?: string | null },
): { 'user.id'?: string; 'user.role'?: string } | null {
  if (identity.kind !== 'jwt') return null;
  const out: Record<string, string> = { 'user.id': (identity as any).userId };
  if ((identity as any).role) out['user.role'] = (identity as any).role;
  return out;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const kvDataRoutes: FastifyPluginAsync = async (fastify) => {

  // ── _batch ─────────────────────────────────────────────────────────────────
  // Must be registered before /:key routes so Fastify doesn't confuse _batch with a key name.
  fastify.post<{
    Params: { app_id: string };
    Body: { ops?: unknown[] };
  }>('/v1/:app_id/kv/_batch', async (req, reply) => {
    const { app_id: appId } = req.params;

    const auth = await resolveKvAuth(fastify.controlDb, appId, req);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const isJwt = auth.identity.kind === 'jwt';
    const isAnon = auth.identity.kind === 'anon';

    const body = req.body as { ops?: unknown[] };
    if (!Array.isArray(body?.ops)) {
      return reply.code(400).send(errBody('bad_request', 'ops must be an array'));
    }
    if (body.ops.length > BATCH_MAX_OPS) {
      return reply
        .code(400)
        .send(errBody('bad_request', `batch limited to ${BATCH_MAX_OPS} ops`));
    }

    // Capture auth as a success shape (we already returned early on error).
    const authOk = auth as import('../../services/kv/auth.js').KvAuthSuccess;
    const baseOpts = baseOptsForRegion(authOk.region, authOk.redisPassword);
    let exposeRules: CompiledRule[] | null = null;
    async function ensureRules(): Promise<CompiledRule[]> {
      if (exposeRules) return exposeRules;
      exposeRules = await withRedis(baseOpts, DURABLE_DB, (c) =>
        loadRules(c, authOk.appId),
      );
      return exposeRules!;
    }

    const results: unknown[] = [];
    await withRedis(baseOpts, DURABLE_DB, async (client) => {
      for (const op of body.ops as Array<{ op?: unknown; key?: unknown; value?: unknown }>) {
        if (typeof op.op !== 'string' || !['get', 'set', 'del'].includes(op.op)) {
          results.push({ error: 'invalid op' });
          continue;
        }
        if (typeof op.key !== 'string' || !isValidUserKey(op.key)) {
          results.push({ error: 'key_invalid' });
          continue;
        }
        if (isJwt || isAnon) {
          const rules = await ensureRules();
          const claims = claimsFromAuth(authOk.identity);
          const required: RequiredAction = op.op === 'get' ? 'read' : 'write';
          const denial = enforceExposeAccess(rules, op.key, required, claims);
          if (denial) {
            results.push({ error: 'KV_FORBIDDEN' });
            continue;
          }
        }
        const fk = userKey(authOk.appId, op.key);
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
    });

    return reply.code(200).send({ results });
  });

  // ── Per-key action routes ──────────────────────────────────────────────────

  // POST /:key/incr
  fastify.post<{
    Params: { app_id: string; key: string };
    Body: { by?: number };
  }>('/v1/:app_id/kv/:key/incr', async (req, reply) => {
    const { app_id: appId, key } = req.params;
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    const auth = await resolveKvAuth(fastify.controlDb, appId, req);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);

    if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
      const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
      const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
      if (denial) return reply.code(denial.status).send(errBody(denial.error));
    }

    const body = (req.body ?? {}) as { by?: unknown };
    const by = typeof body.by === 'number' ? body.by : 1;
    if (!Number.isInteger(by)) {
      return reply.code(400).send(errBody('bad_request', 'by must be an integer'));
    }
    const fk = userKey(auth.appId, key);
    const value = await withRedis(baseOpts, DURABLE_DB, (c) => c.incrBy(fk, by));
    return reply.code(200).send({ value });
  });

  // POST /:key/decr
  fastify.post<{
    Params: { app_id: string; key: string };
    Body: { by?: number };
  }>('/v1/:app_id/kv/:key/decr', async (req, reply) => {
    const { app_id: appId, key } = req.params;
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    const auth = await resolveKvAuth(fastify.controlDb, appId, req);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);

    if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
      const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
      const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
      if (denial) return reply.code(denial.status).send(errBody(denial.error));
    }

    const body = (req.body ?? {}) as { by?: unknown };
    const by = typeof body.by === 'number' ? body.by : 1;
    if (!Number.isInteger(by)) {
      return reply.code(400).send(errBody('bad_request', 'by must be an integer'));
    }
    const fk = userKey(auth.appId, key);
    const value = await withRedis(baseOpts, DURABLE_DB, (c) => c.decrBy(fk, by));
    return reply.code(200).send({ value });
  });

  // POST /:key/setnx
  fastify.post<{
    Params: { app_id: string; key: string };
    Body: { value: unknown; ttl?: number | null; ephemeral?: boolean };
  }>('/v1/:app_id/kv/:key/setnx', async (req, reply) => {
    const { app_id: appId, key } = req.params;
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    const auth = await resolveKvAuth(fastify.controlDb, appId, req);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);

    if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
      const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
      const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
      if (denial) return reply.code(denial.status).send(errBody(denial.error));
    }

    const body = req.body as { value?: unknown; ttl?: unknown; ephemeral?: boolean };
    if (!('value' in body)) return reply.code(400).send(errBody('bad_request', 'missing value'));

    const ttlResult = resolveTtl(body.ttl);
    if (!ttlResult.ok) return reply.code(400).send(errBody(ttlResult.error, ttlResult.message));
    const resolvedTtl = ttlResult.ttl;

    const db = body.ephemeral === true ? EPHEMERAL_DB : DURABLE_DB;
    const encoded = JSON.stringify(body.value);
    const sizeErr = checkValueSize(encoded);
    if (sizeErr) return reply.code(413).send(errBody('KV_VALUE_TOO_LARGE', sizeErr));

    const fk = userKey(auth.appId, key);
    const wrote = await withRedis(baseOpts, db, (c) =>
      c.setWithOptions(fk, encoded, {
        ex: resolvedTtl !== null ? resolvedTtl : undefined,
        nx: true,
      }),
    );
    if (wrote) await deleteFromOtherDb(baseOpts, db, fk);
    return reply.code(wrote ? 201 : 200).send({ wrote });
  });

  // POST /:key/cas
  fastify.post<{
    Params: { app_id: string; key: string };
    Body: { expected: unknown; next: unknown };
  }>('/v1/:app_id/kv/:key/cas', async (req, reply) => {
    const { app_id: appId, key } = req.params;
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    const auth = await resolveKvAuth(fastify.controlDb, appId, req);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);

    if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
      const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
      const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
      if (denial) return reply.code(denial.status).send(errBody(denial.error));
    }

    const body = req.body as { expected?: unknown; next?: unknown };
    if (!('expected' in body) || !('next' in body)) {
      return reply.code(400).send(errBody('bad_request', 'missing expected or next'));
    }

    const expectedArg =
      body.expected === null ? '__NULL__' : JSON.stringify(body.expected);
    const nextArg = JSON.stringify(body.next);
    const sizeErr = checkValueSize(nextArg);
    if (sizeErr) return reply.code(413).send(errBody('KV_VALUE_TOO_LARGE', sizeErr));

    const fk = userKey(auth.appId, key);
    const r = await withRedis(baseOpts, DURABLE_DB, (c) =>
      c.eval(CAS_SCRIPT, [fk], [expectedArg, nextArg]),
    );
    return reply.code(200).send({ swapped: r === 1 });
  });

  // POST /:key/expire
  fastify.post<{
    Params: { app_id: string; key: string };
    Body: { ttl: number | null };
  }>('/v1/:app_id/kv/:key/expire', async (req, reply) => {
    const { app_id: appId, key } = req.params;
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    const auth = await resolveKvAuth(fastify.controlDb, appId, req);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);

    if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
      const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
      const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
      if (denial) return reply.code(denial.status).send(errBody(denial.error));
    }

    const body = req.body as { ttl?: unknown };
    if (!('ttl' in body)) return reply.code(400).send(errBody('bad_request', 'missing ttl'));

    const ttl = body.ttl as number | null;
    if (ttl !== null && (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 0)) {
      return reply
        .code(400)
        .send(errBody('bad_request', 'ttl must be a non-negative integer or null'));
    }

    const fk = userKey(auth.appId, key);
    const applied = await withRedis(baseOpts, DURABLE_DB, (c) => c.expire(fk, ttl));
    return reply.code(200).send({ applied });
  });

  // GET /:key/ttl
  fastify.get<{
    Params: { app_id: string; key: string };
  }>('/v1/:app_id/kv/:key/ttl', async (req, reply) => {
    const { app_id: appId, key } = req.params;
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    const auth = await resolveKvAuth(fastify.controlDb, appId, req);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);

    if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
      const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
      const denial = enforceExposeAccess(rules, key, 'read', claimsFromAuth(auth.identity));
      if (denial) return reply.code(denial.status).send(errBody(denial.error));
    }

    const fk = userKey(auth.appId, key);
    let t = await withRedis(baseOpts, DURABLE_DB, (c) => c.ttl(fk));
    if (t === -2) t = await withRedis(baseOpts, EPHEMERAL_DB, (c) => c.ttl(fk));
    if (t === -2) return reply.code(404).send(errBody('not_found'));
    return reply.code(200).send({ ttl: t === -1 ? null : t });
  });

  // GET /:key/exists
  fastify.get<{
    Params: { app_id: string; key: string };
  }>('/v1/:app_id/kv/:key/exists', async (req, reply) => {
    const { app_id: appId, key } = req.params;
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    const auth = await resolveKvAuth(fastify.controlDb, appId, req);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);

    if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
      const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
      const denial = enforceExposeAccess(rules, key, 'read', claimsFromAuth(auth.identity));
      if (denial) return reply.code(denial.status).send(errBody(denial.error));
    }

    const fk = userKey(auth.appId, key);
    const existsDurable = await withRedis(baseOpts, DURABLE_DB, (c) => c.exists(fk));
    if (existsDurable) return reply.code(200).send({ exists: true });
    const existsEphemeral = await withRedis(baseOpts, EPHEMERAL_DB, (c) => c.exists(fk));
    return reply.code(200).send({ exists: existsEphemeral });
  });

  // ── Base CRUD ──────────────────────────────────────────────────────────────

  // GET /:key
  fastify.get<{
    Params: { app_id: string; key: string };
    Querystring: { touch?: string };
  }>('/v1/:app_id/kv/:key', async (req, reply) => {
    const { app_id: appId, key } = req.params;
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    const auth = await resolveKvAuth(fastify.controlDb, appId, req);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);

    if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
      const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
      const denial = enforceExposeAccess(rules, key, 'read', claimsFromAuth(auth.identity));
      if (denial) return reply.code(denial.status).send(errBody(denial.error));
    }

    const touch = req.query.touch === 'true';
    const fk = userKey(auth.appId, key);

    let foundIn: number | null = null;
    let v: string | null = null;

    await withRedis(baseOpts, DURABLE_DB, async (c) => {
      v = await c.get(fk);
      if (v !== null) foundIn = DURABLE_DB;
    });
    if (v === null) {
      await withRedis(baseOpts, EPHEMERAL_DB, async (c) => {
        v = await c.get(fk);
        if (v !== null) foundIn = EPHEMERAL_DB;
      });
    }
    if (v === null) return reply.code(404).send(errBody('not_found'));

    // Touch-on-read: only for durable hits. Ephemeral keys are allowed to expire.
    if (touch && foundIn === DURABLE_DB) {
      try {
        await withRedis(baseOpts, DURABLE_DB, async (c) => {
          const sidecarKey = sidecarTtlKey(auth.appId, key);
          const stored = await c.get(sidecarKey);
          let originalTtl: number | null = stored !== null ? Number(stored) : null;
          if (originalTtl === null) {
            const cur = await c.ttl(fk);
            if (cur > 0) {
              originalTtl = cur;
              await c.setex(sidecarKey, cur * 2, String(cur));
            }
          }
          if (originalTtl !== null && originalTtl > 0) {
            await c.expire(fk, originalTtl);
          }
        });
      } catch (e) {
        console.warn('[kv-data] touch failed (swallowed):', (e as any)?.message ?? e);
      }
    }

    return reply.code(200).send({ value: JSON.parse(v!) });
  });

  // PUT /:key
  fastify.put<{
    Params: { app_id: string; key: string };
    Body: { value: unknown; ttl?: number | null; ephemeral?: boolean };
  }>('/v1/:app_id/kv/:key', async (req, reply) => {
    const { app_id: appId, key } = req.params;
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    const auth = await resolveKvAuth(fastify.controlDb, appId, req);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);

    if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
      const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
      const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
      if (denial) return reply.code(denial.status).send(errBody(denial.error));
    }

    const body = req.body as { value?: unknown; ttl?: unknown; ephemeral?: boolean };
    if (!('value' in body)) return reply.code(400).send(errBody('bad_request', 'missing value'));

    const ttlResult = resolveTtl(body.ttl);
    if (!ttlResult.ok) return reply.code(400).send(errBody(ttlResult.error, ttlResult.message));
    const resolvedTtl = ttlResult.ttl;

    const db = body.ephemeral === true ? EPHEMERAL_DB : DURABLE_DB;
    const encoded = JSON.stringify(body.value);
    const sizeErr = checkValueSize(encoded);
    if (sizeErr) return reply.code(413).send(errBody('KV_VALUE_TOO_LARGE', sizeErr));

    const fk = userKey(auth.appId, key);
    await withRedis(baseOpts, db, async (c) => {
      if (resolvedTtl === null) {
        await c.set(fk, encoded);
      } else {
        await c.setex(fk, resolvedTtl, encoded);
      }
    });
    await deleteFromOtherDb(baseOpts, db, fk);
    return reply.code(204).send();
  });

  // DELETE /:key
  fastify.delete<{
    Params: { app_id: string; key: string };
  }>('/v1/:app_id/kv/:key', async (req, reply) => {
    const { app_id: appId, key } = req.params;
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    const auth = await resolveKvAuth(fastify.controlDb, appId, req);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);

    if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
      const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
      const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
      if (denial) return reply.code(denial.status).send(errBody(denial.error));
    }

    const fk = userKey(auth.appId, key);
    const delDur = await withRedis(baseOpts, DURABLE_DB, (c) => c.del([fk]));
    const delEph = await withRedis(baseOpts, EPHEMERAL_DB, (c) => c.del([fk]));
    return reply.code(200).send({ deleted: delDur + delEph });
  });
};

export default kvDataRoutes;
