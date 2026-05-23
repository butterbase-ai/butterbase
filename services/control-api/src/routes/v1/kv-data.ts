/**
 * kv-data.ts — Fastify plugin for KV data-plane routes.
 *
 * Ported verbatim from kv-gateway/src/worker.ts, replacing Worker fetch()
 * primitives with Fastify route handlers. Behavior is identical.
 *
 * Routes handled:
 *   GET    /v1/:app_id/kv/*           → {value, ttl?} or 404  (key = wildcard, or key/ttl, key/exists)
 *   PUT    /v1/:app_id/kv/*           → 204                    (key = wildcard)
 *   DELETE /v1/:app_id/kv/*           → {deleted: N}           (key = wildcard)
 *   POST   /v1/:app_id/kv/_batch      → {results: [...]}       (literal, registered first)
 *   POST   /v1/:app_id/kv/*           → action dispatch        (key/incr, key/decr, key/setnx, key/cas, key/expire)
 *
 * Wildcard routes allow slashes in keys (e.g. session/abc-123). Fastify's radix tree
 * gives the literal `kv` segment precedence over the `:table` param in auto-api.ts,
 * so wildcard wins for all URLs under /v1/<app>/kv/...
 *
 * Action-suffix ambiguity: a key ending in /incr (e.g. key="session/incr") is
 * indistinguishable from key="session" + action="incr" — the last segment wins as
 * action. This matches the kv-gateway regex behavior exactly. Users wanting a
 * literal key ending in an action word must encode it (%2Fincr).
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

// ── Size-delta helper ─────────────────────────────────────────────────────────

/**
 * Compute the net storage byte delta for a write operation.
 *
 * oldRaw — the old JSON-encoded value retrieved from Redis before the write
 *           (null when the key did not exist).
 * newRaw — the new JSON-encoded value that was written to Redis
 *           (null for deletes).
 *
 * A positive delta means bytes were added; negative means bytes were freed.
 * The daily reconcile (Task 7) corrects any drift from missed read-before-write.
 */
function sizeDeltaBytes(oldRaw: string | null, newRaw: string | null): number {
  const oldBytes = oldRaw !== null ? Buffer.byteLength(oldRaw) : 0;
  const newBytes = newRaw !== null ? Buffer.byteLength(newRaw) : 0;
  return newBytes - oldBytes;
}

/**
 * Compute the net key count delta for a write operation.
 *
 * oldRaw — the old value (null when the key did not exist).
 * newRaw — the new value (null for deletes).
 *
 * Returns 1 if creating a new key, -1 if deleting, 0 otherwise.
 */
function keyDeltaForWrite(oldRaw: string | null, newRaw: string | null): number {
  if (oldRaw === null && newRaw !== null) return 1;
  if (oldRaw !== null && newRaw === null) return -1;
  return 0;
}

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

// Set of action suffixes recognized in the wildcard URL tail.
const ACTIONS = new Set(['incr', 'decr', 'setnx', 'cas', 'expire', 'ttl', 'exists']);

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

// ── Wildcard key/action parser ────────────────────────────────────────────────

/**
 * Parse the wildcard suffix from a URL like /v1/:app_id/kv/*.
 *
 * Rules (matching kv-gateway regex behavior exactly):
 * - Split on the last `/`
 * - If the tail segment is a known action word, key = everything before the last `/`
 * - Otherwise key = the full wildcard, action = null
 *
 * Ambiguity: a key "session/incr" is parsed as key="session", action="incr".
 * This is the same ambiguity the gateway had. Users needing a literal key
 * ending in an action word must URL-encode the slash (%2F).
 */
function parseWildcard(wildcard: string): { key: string; action: string | null } {
  const slash = wildcard.lastIndexOf('/');
  const tail = slash >= 0 ? wildcard.slice(slash + 1) : wildcard;
  const isAction = ACTIONS.has(tail);
  const key = isAction ? wildcard.slice(0, slash) : wildcard;
  const action = isAction ? tail : null;
  return { key, action };
}

// ── Handler helpers (extracted to keep wildcard handlers small) ───────────────

type AuthOk = import('../../services/kv/auth.js').KvAuthSuccess;
type AccountFn = (sizeDelta: number, keyDelta: number) => void;

async function handleGet(
  key: string,
  auth: AuthOk,
  baseOpts: Omit<RedisClientOptions, 'db'>,
  touch: boolean,
  reply: import('fastify').FastifyReply,
  account: AccountFn,
) {
  if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
    const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
    const denial = enforceExposeAccess(rules, key, 'read', claimsFromAuth(auth.identity));
    if (denial) return reply.code(denial.status).send(errBody(denial.error));
  }

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

  // Reads don't change storage or keys; pass deltas=0
  account(0, 0);
  return reply.code(200).send({ value: JSON.parse(v!) });
}

async function handleGetTtl(
  key: string,
  auth: AuthOk,
  baseOpts: Omit<RedisClientOptions, 'db'>,
  reply: import('fastify').FastifyReply,
  account: AccountFn,
) {
  if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
    const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
    const denial = enforceExposeAccess(rules, key, 'read', claimsFromAuth(auth.identity));
    if (denial) return reply.code(denial.status).send(errBody(denial.error));
  }

  const fk = userKey(auth.appId, key);
  let t = await withRedis(baseOpts, DURABLE_DB, (c) => c.ttl(fk));
  if (t === -2) t = await withRedis(baseOpts, EPHEMERAL_DB, (c) => c.ttl(fk));
  if (t === -2) return reply.code(404).send(errBody('not_found'));
  account(0, 0);
  return reply.code(200).send({ ttl: t === -1 ? null : t });
}

async function handleGetExists(
  key: string,
  auth: AuthOk,
  baseOpts: Omit<RedisClientOptions, 'db'>,
  reply: import('fastify').FastifyReply,
  account: AccountFn,
) {
  if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
    const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
    const denial = enforceExposeAccess(rules, key, 'read', claimsFromAuth(auth.identity));
    if (denial) return reply.code(denial.status).send(errBody(denial.error));
  }

  const fk = userKey(auth.appId, key);
  const existsDurable = await withRedis(baseOpts, DURABLE_DB, (c) => c.exists(fk));
  account(0, 0);
  if (existsDurable) return reply.code(200).send({ exists: true });
  const existsEphemeral = await withRedis(baseOpts, EPHEMERAL_DB, (c) => c.exists(fk));
  return reply.code(200).send({ exists: existsEphemeral });
}

async function handlePut(
  key: string,
  auth: AuthOk,
  baseOpts: Omit<RedisClientOptions, 'db'>,
  body: { value?: unknown; ttl?: unknown; ephemeral?: boolean },
  reply: import('fastify').FastifyReply,
  account: AccountFn,
) {
  if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
    const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
    const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
    if (denial) return reply.code(denial.status).send(errBody(denial.error));
  }

  if (!('value' in body)) return reply.code(400).send(errBody('bad_request', 'missing value'));

  const ttlResult = resolveTtl(body.ttl);
  if (!ttlResult.ok) return reply.code(400).send(errBody(ttlResult.error, ttlResult.message));
  const resolvedTtl = ttlResult.ttl;

  const db = body.ephemeral === true ? EPHEMERAL_DB : DURABLE_DB;
  const encoded = JSON.stringify(body.value);
  const sizeErr = checkValueSize(encoded);
  if (sizeErr) return reply.code(413).send(errBody('KV_VALUE_TOO_LARGE', sizeErr));

  const fk = userKey(auth.appId, key);

  // Read the old value to compute the accurate storage delta.
  // The GET is cheap on the same shard. The daily reconcile (Task 7) corrects
  // any drift in case this read races with a concurrent write.
  let oldRaw: string | null = null;
  try {
    oldRaw = await withRedis(baseOpts, db, (c) => c.get(fk));
  } catch {
    // best-effort; delta will be slightly inaccurate, reconcile corrects it
  }

  await withRedis(baseOpts, db, async (c) => {
    if (resolvedTtl === null) {
      await c.set(fk, encoded);
    } else {
      await c.setex(fk, resolvedTtl, encoded);
    }
  });
  await deleteFromOtherDb(baseOpts, db, fk);
  account(sizeDeltaBytes(oldRaw, encoded), keyDeltaForWrite(oldRaw, encoded));
  return reply.code(204).send();
}

async function handleDelete(
  key: string,
  auth: AuthOk,
  baseOpts: Omit<RedisClientOptions, 'db'>,
  reply: import('fastify').FastifyReply,
  account: AccountFn,
) {
  if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
    const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
    const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
    if (denial) return reply.code(denial.status).send(errBody(denial.error));
  }

  const fk = userKey(auth.appId, key);

  // Read old value from both DBs before deletion to compute size delta.
  let oldDurable: string | null = null;
  let oldEphemeral: string | null = null;
  try {
    oldDurable = await withRedis(baseOpts, DURABLE_DB, (c) => c.get(fk));
    oldEphemeral = await withRedis(baseOpts, EPHEMERAL_DB, (c) => c.get(fk));
  } catch {
    // best-effort
  }

  const delDur = await withRedis(baseOpts, DURABLE_DB, (c) => c.del([fk]));
  const delEph = await withRedis(baseOpts, EPHEMERAL_DB, (c) => c.del([fk]));

  // Negative delta: bytes freed by the deletion
  const freed = (oldDurable !== null ? Buffer.byteLength(oldDurable) : 0)
    + (oldEphemeral !== null ? Buffer.byteLength(oldEphemeral) : 0);
  // Key is deleted if it existed in at least one DB
  const keyDelta = oldDurable !== null || oldEphemeral !== null ? -1 : 0;
  account(-freed, keyDelta);

  return reply.code(200).send({ deleted: delDur + delEph });
}

async function handleIncr(
  key: string,
  auth: AuthOk,
  baseOpts: Omit<RedisClientOptions, 'db'>,
  body: { by?: unknown },
  reply: import('fastify').FastifyReply,
  account: AccountFn,
) {
  if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
    const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
    const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
    if (denial) return reply.code(denial.status).send(errBody(denial.error));
  }

  const by = typeof body.by === 'number' ? body.by : 1;
  if (!Number.isInteger(by)) {
    return reply.code(400).send(errBody('bad_request', 'by must be an integer'));
  }
  const fk = userKey(auth.appId, key);

  // Read old raw value to compute size delta (number length may change)
  let oldRaw: string | null = null;
  try {
    oldRaw = await withRedis(baseOpts, DURABLE_DB, (c) => c.get(fk));
  } catch { /* best-effort */ }

  const value = await withRedis(baseOpts, DURABLE_DB, (c) => c.incrBy(fk, by));
  const newRaw = String(value);
  account(sizeDeltaBytes(oldRaw, newRaw), keyDeltaForWrite(oldRaw, newRaw));
  return reply.code(200).send({ value });
}

async function handleDecr(
  key: string,
  auth: AuthOk,
  baseOpts: Omit<RedisClientOptions, 'db'>,
  body: { by?: unknown },
  reply: import('fastify').FastifyReply,
  account: AccountFn,
) {
  if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
    const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
    const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
    if (denial) return reply.code(denial.status).send(errBody(denial.error));
  }

  const by = typeof body.by === 'number' ? body.by : 1;
  if (!Number.isInteger(by)) {
    return reply.code(400).send(errBody('bad_request', 'by must be an integer'));
  }
  const fk = userKey(auth.appId, key);

  // Read old raw value to compute size delta (number length may change)
  let oldRaw: string | null = null;
  try {
    oldRaw = await withRedis(baseOpts, DURABLE_DB, (c) => c.get(fk));
  } catch { /* best-effort */ }

  const value = await withRedis(baseOpts, DURABLE_DB, (c) => c.decrBy(fk, by));
  const newRaw = String(value);
  account(sizeDeltaBytes(oldRaw, newRaw), keyDeltaForWrite(oldRaw, newRaw));
  return reply.code(200).send({ value });
}

async function handleSetnx(
  key: string,
  auth: AuthOk,
  baseOpts: Omit<RedisClientOptions, 'db'>,
  body: { value?: unknown; ttl?: unknown; ephemeral?: boolean },
  reply: import('fastify').FastifyReply,
  account: AccountFn,
) {
  if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
    const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
    const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
    if (denial) return reply.code(denial.status).send(errBody(denial.error));
  }

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
  if (wrote) {
    await deleteFromOtherDb(baseOpts, db, fk);
    // setnx only writes if key didn't exist; delta is the full new value size + 1 key
    account(sizeDeltaBytes(null, encoded), keyDeltaForWrite(null, encoded));
  } else {
    // Key already existed; no storage change
    account(0, 0);
  }
  return reply.code(wrote ? 201 : 200).send({ wrote });
}

async function handleCas(
  key: string,
  auth: AuthOk,
  baseOpts: Omit<RedisClientOptions, 'db'>,
  body: { expected?: unknown; next?: unknown },
  reply: import('fastify').FastifyReply,
  account: AccountFn,
) {
  if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
    const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
    const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
    if (denial) return reply.code(denial.status).send(errBody(denial.error));
  }

  if (!('expected' in body) || !('next' in body)) {
    return reply.code(400).send(errBody('bad_request', 'missing expected or next'));
  }

  const expectedArg =
    body.expected === null ? '__NULL__' : JSON.stringify(body.expected);
  const nextArg = JSON.stringify(body.next);
  const sizeErr = checkValueSize(nextArg);
  if (sizeErr) return reply.code(413).send(errBody('KV_VALUE_TOO_LARGE', sizeErr));

  const fk = userKey(auth.appId, key);

  // Read old value before CAS to compute delta on success
  let oldRaw: string | null = null;
  try {
    oldRaw = await withRedis(baseOpts, DURABLE_DB, (c) => c.get(fk));
  } catch { /* best-effort */ }

  const r = await withRedis(baseOpts, DURABLE_DB, (c) =>
    c.eval(CAS_SCRIPT, [fk], [expectedArg, nextArg]),
  );
  const swapped = r === 1;
  if (swapped) {
    account(sizeDeltaBytes(oldRaw, nextArg), keyDeltaForWrite(oldRaw, nextArg));
  } else {
    account(0, 0);
  }
  return reply.code(200).send({ swapped });
}

async function handleExpire(
  key: string,
  auth: AuthOk,
  baseOpts: Omit<RedisClientOptions, 'db'>,
  body: { ttl?: unknown },
  reply: import('fastify').FastifyReply,
  account: AccountFn,
) {
  if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
    const rules = await withRedis(baseOpts, DURABLE_DB, (c) => loadRules(c, auth.appId));
    const denial = enforceExposeAccess(rules, key, 'write', claimsFromAuth(auth.identity));
    if (denial) return reply.code(denial.status).send(errBody(denial.error));
  }

  if (!('ttl' in body)) return reply.code(400).send(errBody('bad_request', 'missing ttl'));

  const ttl = body.ttl as number | null;
  if (ttl !== null && (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 0)) {
    return reply
      .code(400)
      .send(errBody('bad_request', 'ttl must be a non-negative integer or null'));
  }

  const fk = userKey(auth.appId, key);
  const applied = await withRedis(baseOpts, DURABLE_DB, (c) => c.expire(fk, ttl));
  // expire doesn't change value bytes or key count; no deltas
  account(0, 0);
  return reply.code(200).send({ applied });
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const kvDataRoutes: FastifyPluginAsync = async (fastify) => {

  // ── _batch ─────────────────────────────────────────────────────────────────
  // Registered as a literal route BEFORE the wildcard, so Fastify routes it first.
  fastify.post<{
    Params: { app_id: string };
    Body: { ops?: unknown[] };
  }>('/v1/:app_id/kv/_batch', async (req, reply) => {
    const { app_id: appId } = req.params;

    const auth = await resolveKvAuth(fastify.controlDb, appId, req, (fastify as any).authProvider);
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
    let batchStorageDelta = 0;
    let batchKeyDelta = 0;
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
            // Read old value before set for accurate storage delta
            let oldRaw: string | null = null;
            try { oldRaw = await client.get(fk); } catch { /* best-effort */ }
            await client.set(fk, encoded);
            batchStorageDelta += sizeDeltaBytes(oldRaw, encoded);
            batchKeyDelta += keyDeltaForWrite(oldRaw, encoded);
            results.push({ ok: true });
          } else if (op.op === 'del') {
            // Read old value before del for accurate storage delta
            let oldRaw: string | null = null;
            try { oldRaw = await client.get(fk); } catch { /* best-effort */ }
            const count = await client.del([fk]);
            if (oldRaw !== null) batchStorageDelta -= Buffer.byteLength(oldRaw);
            batchKeyDelta += keyDeltaForWrite(oldRaw, null);
            results.push({ deleted: count });
          }
        } catch (e) {
          results.push({ error: 'redis_error', message: (e as any)?.message ?? 'unknown error' });
        }
      }
    });

    // Account for the batch as a whole after all ops complete
    if ((fastify as any).kvAccount) {
      (fastify as any).kvAccount(req, batchStorageDelta, batchKeyDelta);
    }

    return reply.code(200).send({ results });
  });

  // ── Wildcard GET /v1/:app_id/kv/* ─────────────────────────────────────────
  // Handles: GET key, GET key/ttl, GET key/exists
  fastify.get<{
    Params: { app_id: string; '*': string };
    Querystring: { touch?: string };
  }>('/v1/:app_id/kv/*', async (req, reply) => {
    const { app_id: appId } = req.params;
    const wildcard = (req.params as Record<string, string>)['*'] ?? '';
    const { key, action } = parseWildcard(wildcard);

    if (!key) return reply.code(400).send(errBody('invalid_key'));
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    const auth = await resolveKvAuth(fastify.controlDb, appId, req, (fastify as any).authProvider);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const authOk = auth as AuthOk;
    const baseOpts = baseOptsForRegion(authOk.region, authOk.redisPassword);

    const account: AccountFn = (sizeDelta, keyDelta) => {
      if ((fastify as any).kvAccount) (fastify as any).kvAccount(req, sizeDelta, keyDelta);
    };

    if (action === 'ttl') {
      return handleGetTtl(key, authOk, baseOpts, reply, account);
    }
    if (action === 'exists') {
      return handleGetExists(key, authOk, baseOpts, reply, account);
    }
    if (action !== null) {
      // No other GET actions defined
      return reply.code(404).send(errBody('not_found'));
    }

    const touch = req.query.touch === 'true';
    return handleGet(key, authOk, baseOpts, touch, reply, account);
  });

  // ── Wildcard PUT /v1/:app_id/kv/* ─────────────────────────────────────────
  // Handles: PUT key (no PUT actions exist)
  fastify.put<{
    Params: { app_id: string; '*': string };
    Body: { value: unknown; ttl?: number | null; ephemeral?: boolean };
  }>('/v1/:app_id/kv/*', async (req, reply) => {
    const { app_id: appId } = req.params;
    const wildcard = (req.params as Record<string, string>)['*'] ?? '';
    const { key, action } = parseWildcard(wildcard);

    if (!key) return reply.code(400).send(errBody('invalid_key'));
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    if (action !== null) {
      // No PUT actions defined
      return reply.code(404).send(errBody('not_found'));
    }

    const auth = await resolveKvAuth(fastify.controlDb, appId, req, (fastify as any).authProvider);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const authOk = auth as AuthOk;
    const baseOpts = baseOptsForRegion(authOk.region, authOk.redisPassword);
    const body = req.body as { value?: unknown; ttl?: unknown; ephemeral?: boolean };
    const account: AccountFn = (sizeDelta, keyDelta) => {
      if ((fastify as any).kvAccount) (fastify as any).kvAccount(req, sizeDelta, keyDelta);
    };
    return handlePut(key, authOk, baseOpts, body, reply, account);
  });

  // ── Wildcard DELETE /v1/:app_id/kv/* ──────────────────────────────────────
  // Handles: DELETE key (no DELETE actions exist)
  fastify.delete<{
    Params: { app_id: string; '*': string };
  }>('/v1/:app_id/kv/*', async (req, reply) => {
    const { app_id: appId } = req.params;
    const wildcard = (req.params as Record<string, string>)['*'] ?? '';
    const { key, action } = parseWildcard(wildcard);

    if (!key) return reply.code(400).send(errBody('invalid_key'));
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    if (action !== null) {
      // No DELETE actions defined
      return reply.code(404).send(errBody('not_found'));
    }

    const auth = await resolveKvAuth(fastify.controlDb, appId, req, (fastify as any).authProvider);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const authOk = auth as AuthOk;
    const baseOpts = baseOptsForRegion(authOk.region, authOk.redisPassword);
    const account: AccountFn = (sizeDelta, keyDelta) => {
      if ((fastify as any).kvAccount) (fastify as any).kvAccount(req, sizeDelta, keyDelta);
    };
    return handleDelete(key, authOk, baseOpts, reply, account);
  });

  // ── Wildcard POST /v1/:app_id/kv/* ────────────────────────────────────────
  // Handles: POST key/incr, key/decr, key/setnx, key/cas, key/expire
  // Note: _batch is caught by its own literal route above.
  fastify.post<{
    Params: { app_id: string; '*': string };
    Body: Record<string, unknown>;
  }>('/v1/:app_id/kv/*', async (req, reply) => {
    const { app_id: appId } = req.params;
    const wildcard = (req.params as Record<string, string>)['*'] ?? '';
    const { key, action } = parseWildcard(wildcard);

    if (!key) return reply.code(400).send(errBody('invalid_key'));
    if (!isValidUserKey(key)) return reply.code(400).send(errBody('key_invalid'));

    if (action === null) {
      // No plain POST on a key without an action suffix
      return reply.code(404).send(errBody('not_found'));
    }

    const auth = await resolveKvAuth(fastify.controlDb, appId, req, (fastify as any).authProvider);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const authOk = auth as AuthOk;
    const baseOpts = baseOptsForRegion(authOk.region, authOk.redisPassword);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const account: AccountFn = (sizeDelta, keyDelta) => {
      if ((fastify as any).kvAccount) (fastify as any).kvAccount(req, sizeDelta, keyDelta);
    };

    switch (action) {
      case 'incr':
        return handleIncr(key, authOk, baseOpts, body, reply, account);
      case 'decr':
        return handleDecr(key, authOk, baseOpts, body, reply, account);
      case 'setnx':
        return handleSetnx(key, authOk, baseOpts, body, reply, account);
      case 'cas':
        return handleCas(key, authOk, baseOpts, body, reply, account);
      case 'expire':
        return handleExpire(key, authOk, baseOpts, body, reply, account);
      default:
        // ttl/exists are GET-only actions; POST to them is not defined
        return reply.code(404).send(errBody('not_found'));
    }
  });
};

export default kvDataRoutes;
