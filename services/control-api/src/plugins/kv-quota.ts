/**
 * kv-quota.ts — Fastify preHandler plugin for KV quota enforcement.
 *
 * Scoped to /v1/:app_id/kv/* routes, this plugin enforces:
 *   1. Rate limit (ops/sec via Redis sliding counter)
 *   2. Value size cap (writes only)
 *   3. Credits balance > 0 (any op)
 *   4. Storage cap (writes only; reads pass even if over cap)
 *
 * Design note: KV op cost (1–2 credits) is too small for the lease/burn pattern
 * used by AI endpoints. Instead we do a balance read (cached 30s by getCreditsBalance)
 * and fire-and-forget incrementUsage. The daily reconcile (Task 7) corrects any drift.
 *
 * Hot-path budget: at most 1 Redis incrby (rate) + cached limits read + cached
 * balance read + 1 Redis get (storage on writes). No retries in preHandler.
 */

import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { resolveKvAuth } from '../services/kv/auth.js';
import { getKvLimitsForApp } from '../services/kv/limits.js';
import { getStorageBytes, incBytes, decBytes } from '../services/kv/storage-counter.js';
import { incKeys, decKeys } from '../services/kv/keys-counter.js';
import { checkRateLimit } from '../services/kv/rate-limit.js';
import { classifyRequest, creditCostForOp, opsCountForOp, type KvOp } from '../services/kv/credits.js';
import { kvRateLimited, kvCreditsExhausted, kvStorageFull } from '../utils/quota-errors.js';
import { getCreditsBalance, incrementUsage } from '../services/usage-metering.js';
import { kvRedisFor } from '../services/kv/redis-registry.js';
import { wrap } from '../services/kv/redis-client.js';
import { resolveOrganizationId } from '../services/org-resolver.js';
import { getRedisClient } from '../services/redis.js';
import { isKvBlocked } from '../services/kv/migration-sentinel.js';

// ---------------------------------------------------------------------------
// Fastify module augmentation — add kvAccount to FastifyInstance
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyInstance {
    kvAccount(request: FastifyRequest, sizeDelta?: number, keyDelta?: number): void;
  }
}

// ---------------------------------------------------------------------------
// KV action suffixes that can appear in the URL tail.
// Mirrors the ACTIONS set in kv-data.ts.
// ---------------------------------------------------------------------------

const KV_ACTIONS = new Set([
  'incr', 'decr', 'setnx', 'cas', 'expire', 'ttl', 'exists',
]);

/**
 * Extract the action suffix from a KV URL.
 *
 * e.g. /v1/app/kv/foo/ttl → "ttl"
 *      /v1/app/kv/foo      → null
 *      /v1/app/kv/_batch   → "_batch"  (literal route, handled separately)
 */
function parseActionFromUrl(url: string): string | null {
  // Strip query string
  const path = url.split('?')[0]!;
  const slash = path.lastIndexOf('/');
  if (slash < 0) return null;
  const tail = path.slice(slash + 1);
  if (KV_ACTIONS.has(tail)) return tail;
  // _batch is a literal route whose batchOps come from the body
  if (tail === '_batch') return '_batch';
  return null;
}

// ---------------------------------------------------------------------------
// Compute byte length of an incoming request body for write-size enforcement.
//
// For PUT:   body is { value: T, ttl?: number, ephemeral?: boolean }
// For batch: body is { ops: Array<{ op, key, value? }> }
// We compute the JSON encoding size of the value(s) since that is what Redis stores.
// ---------------------------------------------------------------------------

function sizeOfBody(body: unknown): number {
  if (body === null || body === undefined) return 0;

  const b = body as Record<string, unknown>;

  // _batch: sum the encoded values
  if (Array.isArray(b.ops)) {
    let total = 0;
    for (const op of b.ops as Array<{ op?: unknown; value?: unknown }>) {
      if (op.value !== undefined) {
        total += Buffer.byteLength(JSON.stringify(op.value));
      }
    }
    return total;
  }

  // Single write: body.value
  if ('value' in b && b.value !== undefined) {
    return Buffer.byteLength(JSON.stringify(b.value));
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Resolve owner ID for an app.
//
// Strategy (cheapest first):
//   1. org_app_index on the control DB joined to platform_users (cross-region map)
//   2. Falls through to null if not found
//
// Cached in Redis for 5 minutes.
// ---------------------------------------------------------------------------

const OWNER_CACHE_TTL = 300;

async function resolveOwnerId(controlDb: Pool, appId: string): Promise<string | null> {
  const cacheKey = `kv:owner:${appId}`;
  try {
    const cached = await getRedisClient().get(cacheKey);
    if (cached) return cached;
  } catch {
    // Redis failure — fall through to DB lookup
  }

  // Try org_app_index (platform-tier, authoritative in production)
  try {
    const r = await controlDb.query<{ user_id: string }>(
      `SELECT pu.id AS user_id
       FROM org_app_index oai
       JOIN organizations o ON o.id = oai.organization_id
       LEFT JOIN platform_users pu ON pu.id = o.owner_id
       WHERE oai.app_id = $1`,
      [appId],
    );
    if (r.rows.length > 0) {
      const ownerId = r.rows[0].user_id;
      getRedisClient().setex(cacheKey, OWNER_CACHE_TTL, ownerId).catch(() => {});
      return ownerId;
    }
  } catch {
    // Fall through
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const kvQuotaPlugin: FastifyPluginAsync = async (fastify) => {

  // ── preHandler: enforce all quota checks before the route handler runs ────

  fastify.addHook('preHandler', async (request, reply) => {
    // Scope: only KV data-plane routes
    if (!/^\/v1\/[^/]+\/kv\//.test(request.url)) return;

    const params = request.params as Record<string, string>;
    const appId = params.app_id;
    if (!appId) return;

    // Resolve auth (already runs inside the route handler; we re-resolve here
    // to get region/ownerId for accounting). If auth fails we return early —
    // the route will send the 401/403.
    const auth = await resolveKvAuth(fastify.controlDb, appId, request, (fastify as any).authProvider);
    if ('error' in auth) return;

    // Parse action from URL (mirrors kv-data.ts parseWildcard logic)
    const action = parseActionFromUrl(request.url);
    const body = request.body as Record<string, unknown> | undefined;
    const batchOps = Array.isArray(body?.ops)
      ? (body!.ops as Array<{ op: string }>)
      : undefined;

    const op = classifyRequest(request.method, action === '_batch' ? null : action, batchOps);
    if (!op) return; // Unrecognized — let the route 404

    // Fetch plan limits (cached 60s via app-plan-resolver Redis layer)
    const limits = await getKvLimitsForApp(fastify.controlDb, appId);

    // KV Redis handle for this app's region (shared long-lived ioredis connection)
    const kvR = wrap(kvRedisFor(auth.region));

    // Migration sentinel — block WRITES during a move-app run.
    // Reads still pass (stale reads from the source are acceptable; once the
    // move flips app_kv_credentials.region, future requests resolve to the dest).
    // Checked before rate-limit so blocked writes don't consume the rate budget.
    if (op.kind === 'write' || op.kind === 'atomic_write' || op.kind === 'mset') {
      if (await isKvBlocked(kvR, appId)) {
        return reply
          .code(503)
          .header('retry-after', '5')
          .send({ error: 'kv_migrating', app_id: appId });
      }
    }

    // ── (1) Rate limit ────────────────────────────────────────────────────
    const opsCount = opsCountForOp(op);
    const rl = await checkRateLimit(kvR, appId, opsCount, limits.maxOpsPerSec);
    if (!rl.allowed) {
      const r = kvRateLimited(rl.retryAfterSec);
      return reply
        .code(r.statusCode)
        .headers(r.headers ?? {})
        .send(r.body);
    }

    // ── (2) Value size cap (writes only) ──────────────────────────────────
    // -1 means unlimited (enterprise / custom tiers).
    const isWrite = op.kind === 'write' || op.kind === 'atomic_write' || op.kind === 'mset';
    if (isWrite && limits.maxValueBytes >= 0) {
      const valBytes = sizeOfBody(body);
      if (valBytes > limits.maxValueBytes) {
        return reply.code(413).send({
          error: 'value_too_large',
          size: valBytes,
          max: limits.maxValueBytes,
        });
      }
    }

    // ── (3) Credits balance ───────────────────────────────────────────────
    const ownerId = await resolveOwnerId(fastify.controlDb, appId);
    if (!ownerId) return; // Shouldn't happen — let route handle auth

    // Skip the balance gate when the op has no credit cost (KV is not metered).
    // If creditCostForOp is changed to return a non-zero cost in the future,
    // the gate re-engages automatically.
    if (creditCostForOp(op) > 0) {
      const bal = await getCreditsBalance(fastify.controlDb, ownerId);
      if (bal.totalUsd <= 0) {
        const r = kvCreditsExhausted();
        return reply.code(r.statusCode).send(r.body);
      }
    }

    // ── (4) Storage cap (writes only; reads pass even if over cap) ────────
    // -1 means unlimited (enterprise / custom tiers).
    if (isWrite && limits.maxStorageBytes >= 0) {
      const used = await getStorageBytes(kvR, appId);
      const incoming = sizeOfBody(body);
      if (used + incoming > limits.maxStorageBytes) {
        const r = kvStorageFull(used, limits.maxStorageBytes);
        return reply.code(r.statusCode).send(r.body);
      }
    }

    // Stash classification + owner + region for the post-op accounting hook
    (request as any).kvOp = op;
    (request as any).kvOwnerId = ownerId;
    (request as any).kvRegion = auth.region;
  });

  // ── kvAccount: post-op accounting decorator ────────────────────────────
  //
  // Called by kv-data.ts route handlers after a successful op to record:
  //   - kv_ops credit cost (via incrementUsage, fire-and-forget Redis counter)
  //   - kv_storage_bytes delta (via incBytes/decBytes on KV Redis)
  //   - kv_keys count delta (via incKeys/decKeys on KV Redis)
  //
  // sizeDelta > 0 → bytes added; < 0 → bytes freed; 0 → no storage change.
  // keyDelta > 0 → keys added; < 0 → keys deleted; 0 → no key count change.

  fastify.decorate('kvAccount', (request: FastifyRequest, sizeDelta = 0, keyDelta = 0) => {
    const op = (request as any).kvOp as KvOp | undefined;
    const ownerId = (request as any).kvOwnerId as string | undefined;
    const region = (request as any).kvRegion as string | undefined;
    const appId = ((request.params as any)?.app_id) as string | undefined;

    if (!op || !ownerId || !appId) return;

    // Non-blocking credit accounting: Redis counter flushed to usage_meters every 60s
    const cost = creditCostForOp(op);
    void (async () => {
      const organizationId = await resolveOrganizationId(fastify.controlDb, ownerId);
      await incrementUsage(organizationId, ownerId, 'kv_ops', cost, appId);
    })();

    if (sizeDelta !== 0) {
      void (async () => {
        const organizationId = await resolveOrganizationId(fastify.controlDb, ownerId);
        await incrementUsage(organizationId, ownerId, 'kv_storage_bytes', Math.abs(sizeDelta), appId);
      })();

      if (region) {
        const kvR = wrap(kvRedisFor(region));
        if (sizeDelta > 0) {
          void incBytes(kvR, appId, sizeDelta);
        } else {
          void decBytes(kvR, appId, -sizeDelta);
        }
      }
    }

    // Key count maintenance. Swallow errors; the reconcile catches drift.
    if (keyDelta !== 0 && region) {
      const kvR = wrap(kvRedisFor(region));
      if (keyDelta > 0) {
        void incKeys(kvR, appId, keyDelta).catch(() => { /* reconcile catches drift */ });
      } else {
        void decKeys(kvR, appId, -keyDelta).catch(() => { /* reconcile catches drift */ });
      }
    }
  });
};

export default fp(kvQuotaPlugin, {
  name: 'kv-quota',
  // Depends on database plugin for fastify.controlDb
  dependencies: ['database'],
});

// Export helpers for testing
export { sizeOfBody, parseActionFromUrl, resolveOwnerId };
