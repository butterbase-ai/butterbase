/**
 * kv-expose.ts — Fastify plugin for KV expose-rule management routes.
 *
 * Ported verbatim from kv-gateway/src/worker.ts expose section.
 *
 * Routes:
 *   GET    /v1/:app_id/kv/_expose                  → {rules: [...]}
 *   PUT    /v1/:app_id/kv/_expose/:pattern          → 204 | 409 {error:'KV_EXPOSE_CONFLICT'}
 *   DELETE /v1/:app_id/kv/_expose/:pattern          → {deleted: bool}
 *
 * Access:
 *   JWT/anon → 403 (expose writes require API key or function key).
 *   auth.allowExposeWrites must be true for PUT/DELETE.
 */

import type { FastifyPluginAsync } from 'fastify';
import { resolveKvAuth } from '../../services/kv/auth.js';
import { RedisClient, type RedisClientOptions } from '../../services/kv/redis-client.js';
import {
  loadRules,
  saveRule,
  deleteRule,
  compileRule,
  detectConflict,
  nextDeclarationOrder,
  type Role,
  type RuleSource,
} from '../../services/kv/expose.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const DURABLE_DB = 0;

const VALID_ROLES: Role[] = ['public', 'authed', 'owner', 'deny'];

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

// ── Plugin ────────────────────────────────────────────────────────────────────

const kvExposeRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /v1/:app_id/kv/_expose
  fastify.get<{ Params: { app_id: string } }>(
    '/v1/:app_id/kv/_expose',
    async (req, reply) => {
      const { app_id: appId } = req.params;

      const auth = await resolveKvAuth(fastify.controlDb, appId, req, (fastify as any).authProvider);
      if ('error' in auth) return reply.code(auth.status).send(auth.body);

      // JWT/anon → 403
      if (auth.identity.kind === 'jwt' || auth.identity.kind === 'anon') {
        return reply.code(403).send(errBody('forbidden'));
      }

      const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);
      const rules = await withRedis(baseOpts, DURABLE_DB, (c) =>
        loadRules(c, auth.appId),
      );
      rules.sort((a, b) => a.declarationOrder - b.declarationOrder);
      return reply.code(200).send({
        rules: rules.map((r) => ({
          pattern: r.pattern,
          read: r.read,
          write: r.write,
          order: r.declarationOrder,
        })),
      });
    },
  );

  // PUT /v1/:app_id/kv/_expose/:pattern
  fastify.put<{
    Params: { app_id: string; pattern: string };
    Body: { read?: unknown; write?: unknown };
  }>('/v1/:app_id/kv/_expose/:pattern', async (req, reply) => {
    const { app_id: appId } = req.params;
    const pattern = decodeURIComponent(req.params.pattern);

    const auth = await resolveKvAuth(fastify.controlDb, appId, req, (fastify as any).authProvider);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    // JWT/anon → 403; require allowExposeWrites
    if (!auth.allowExposeWrites) {
      return reply.code(403).send(errBody('forbidden'));
    }

    const body = req.body as { read?: unknown; write?: unknown };
    if (
      !VALID_ROLES.includes(body.read as Role) ||
      !VALID_ROLES.includes(body.write as Role)
    ) {
      return reply
        .code(400)
        .send(errBody('bad_request', 'read and write must be public|authed|owner|deny'));
    }

    const newRule: RuleSource = {
      pattern,
      read: body.read as Role,
      write: body.write as Role,
    };

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);
    return withRedis(baseOpts, DURABLE_DB, async (c) => {
      const existing = await loadRules(c, auth.appId);
      const compiled = compileRule(newRule, 0);
      const conflict = detectConflict(existing, compiled);
      if (conflict) {
        return reply.code(409).send({
          error: 'KV_EXPOSE_CONFLICT',
          message: 'pattern conflicts with existing rule',
          existing: {
            pattern: conflict.pattern,
            read: conflict.read,
            write: conflict.write,
          },
        });
      }
      // Idempotent same-rule save: preserve declarationOrder if already present.
      const existingIdx = existing.findIndex((r) => r.pattern === newRule.pattern);
      const order =
        existingIdx >= 0
          ? existing[existingIdx].declarationOrder
          : await nextDeclarationOrder(c, auth.appId);
      await saveRule(c, auth.appId, newRule, order);
      return reply.code(204).send();
    });
  });

  // DELETE /v1/:app_id/kv/_expose/:pattern
  fastify.delete<{
    Params: { app_id: string; pattern: string };
  }>('/v1/:app_id/kv/_expose/:pattern', async (req, reply) => {
    const { app_id: appId } = req.params;
    const pattern = decodeURIComponent(req.params.pattern);

    const auth = await resolveKvAuth(fastify.controlDb, appId, req, (fastify as any).authProvider);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    // JWT/anon → 403; require allowExposeWrites
    if (!auth.allowExposeWrites) {
      return reply.code(403).send(errBody('forbidden'));
    }

    const baseOpts = baseOptsForRegion(auth.region, auth.redisPassword);
    const ok = await withRedis(baseOpts, DURABLE_DB, (c) =>
      deleteRule(c, auth.appId, pattern),
    );
    return reply.code(200).send({ deleted: ok ? 1 : 0 });
  });
};

export default kvExposeRoutes;
