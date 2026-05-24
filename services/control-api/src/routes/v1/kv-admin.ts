/**
 * kv-admin.ts — Fastify plugin for KV admin routes.
 *
 * Ported verbatim from kv-gateway/src/worker.ts admin section.
 *
 * Routes:
 *   GET  /v1/:app_id/kv/_scan?prefix=&limit=&cursor=  → {keys, cursor}
 *   GET  /v1/:app_id/kv/_stats                        → {keys_total, bytes_used, ops_per_sec: null}
 *   POST /v1/:app_id/kv/_flush                         → {deleted} | 400 {error:'confirm_required'}
 *
 * All three reject JWT/anon with 403.
 */

import type { FastifyPluginAsync } from 'fastify';
import { resolveKvAuth } from '../../services/kv/auth.js';
import { type RedisClientOptions } from '../../services/kv/redis-client.js';
import { scanKeys, appStats, flushApp } from '../../services/kv/admin.js';
import { getKvLimitsForApp } from '../../services/kv/limits.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function errBody(code: string, message?: string): Record<string, string> {
  return { error: code, message: message ?? code };
}

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

// ── Plugin ────────────────────────────────────────────────────────────────────

const kvAdminRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /v1/:app_id/kv/_scan
  fastify.get<{
    Params: { app_id: string };
    Querystring: { prefix?: string; limit?: string; cursor?: string };
  }>('/v1/:app_id/kv/_scan', { config: { public: true } }, async (req, reply) => {
    const { app_id: appId } = req.params;

    const auth = await resolveKvAuth(fastify.controlDb, appId, req, (fastify as any).authProvider);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    // JWT/anon → 403
    if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
      return reply.code(403).send(errBody('forbidden'));
    }

    const { prefix, limit: limitParam } = req.query;
    const limit = limitParam !== undefined ? Number(limitParam) : undefined;

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);
    const result = await scanKeys(baseOpts, auth.appId, { prefix, limit });
    return reply.code(200).send(result);
  });

  // GET /v1/:app_id/kv/_stats
  fastify.get<{
    Params: { app_id: string };
  }>('/v1/:app_id/kv/_stats', { config: { public: true } }, async (req, reply) => {
    const { app_id: appId } = req.params;

    const auth = await resolveKvAuth(fastify.controlDb, appId, req, (fastify as any).authProvider);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    // JWT/anon → 403
    if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
      return reply.code(403).send(errBody('forbidden'));
    }

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);
    const limits = await getKvLimitsForApp(fastify.controlDb, appId);
    const result = await appStats(baseOpts, auth.appId, limits);
    return reply.code(200).send(result);
  });

  // POST /v1/:app_id/kv/_flush
  fastify.post<{
    Params: { app_id: string };
    Body: { confirm?: unknown; include_config?: boolean };
  }>('/v1/:app_id/kv/_flush', { config: { public: true } }, async (req, reply) => {
    const { app_id: appId } = req.params;

    const auth = await resolveKvAuth(fastify.controlDb, appId, req, (fastify as any).authProvider);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    // JWT/anon → 403
    if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
      return reply.code(403).send(errBody('forbidden'));
    }

    const body = (req.body ?? {}) as { confirm?: unknown; include_config?: boolean };
    if (body.confirm !== true) {
      return reply.code(400).send(errBody('confirm_required'));
    }

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);
    const result = await flushApp(baseOpts, auth.appId, {
      include_config: body.include_config,
    });
    return reply.code(200).send(result);
  });
};

export default kvAdminRoutes;
