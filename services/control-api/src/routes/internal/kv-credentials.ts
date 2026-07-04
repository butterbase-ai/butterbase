import crypto from 'crypto';
import type { FastifyPluginAsync } from 'fastify';
import { KvCredentialsService } from '../../services/kv-credentials.js';
import { AppNotFoundError, AppResolver } from '../../services/app-resolver.js';

const kvCredentialsRoutes: FastifyPluginAsync = async (fastify) => {
  const svc = new KvCredentialsService(fastify.controlDb);

  fastify.get<{ Params: { app_id: string } }>(
    '/v1/internal/kv/credentials/:app_id',
    async (req, reply) => {
      const cred = await svc.lookup(req.params.app_id);
      if (!cred) return reply.code(404).send({ error: 'not_found' });
      return {
        app_id: cred.app_id,
        region: cred.region,
        redis_password: cred.redis_password,
      };
    },
  );

  fastify.post<{ Body: { api_key: string; app_id: string } }>(
    '/v1/internal/kv/resolve-key',
    async (req, reply) => {
      const { api_key: rawKey, app_id: appId } = req.body ?? {};
      if (!rawKey || !appId) return reply.code(400).send({ error: 'missing_fields' });

      // Three-step validation:
      //   1. api_key → user_id (control DB).
      //   2. user owns app — apps lives in the per-region runtime DB
      //      post-cutover (migration 061), so resolve the home region first.
      //   3. kv credential exists for the app (control DB).
      // Falls back to the per-app function key path when the user-supplied
      // value isn't a valid hashed API key.
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const keyResult = await fastify.controlDb.query<{ user_id: string; organization_id: string | null }>(
        `SELECT user_id, organization_id FROM api_keys
         WHERE key_hash = $1
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
         LIMIT 1`,
        [keyHash],
      );

      if (keyResult.rows.length === 1) {
        const keyUserId = keyResult.rows[0].user_id;
        const keyOrganizationId = keyResult.rows[0].organization_id;

        try {
          // Strict per-key-org scoping: the api key is bound to a specific
          // organization; the app MUST live in that same org.
          await AppResolver.resolveApp(fastify.controlDb, appId, keyUserId, keyOrganizationId);
        } catch (err) {
          if (err instanceof AppNotFoundError) {
            return reply.code(403).send({ error: 'forbidden' });
          }
          throw err;
        }
        // Ownership verified — continue to credential lookup

        const credResult = await fastify.controlDb.query<{
          app_id: string;
          region: string;
          redis_password: string;
        }>(
          `SELECT app_id, region, redis_password
           FROM app_kv_credentials
           WHERE app_id = $1
           LIMIT 1`,
          [appId],
        );
        if (credResult.rows.length === 0) {
          return reply.code(404).send({ error: 'no_kv_credential' });
        }
        const r = credResult.rows[0];
        return { app_id: r.app_id, region: r.region, redis_password: r.redis_password };
      }

      // Fallback: per-app function key (auto-injected into deno-runtime), stored unhashed (internal credential, not user-supplied API key).
      const fk = await fastify.controlDb.query<{
        app_id: string;
        region: string;
        redis_password: string;
      }>(
        `SELECT app_id, region, redis_password
         FROM app_kv_credentials
         WHERE kv_function_key = $1 AND app_id = $2`,
        [rawKey, appId],
      );
      if (fk.rows.length === 1) {
        const r = fk.rows[0];
        return { app_id: r.app_id, region: r.region, redis_password: r.redis_password };
      }
      return reply.code(404).send({ error: 'invalid_key' });
    },
  );

  fastify.get<{ Params: { app_id: string } }>(
    '/v1/internal/kv/anon-credentials/:app_id',
    async (req, reply) => {
      const cred = await svc.lookup(req.params.app_id);
      if (!cred) return reply.code(404).send({ error: 'no_kv_credential' });
      return { app_id: cred.app_id, region: cred.region, redis_password: cred.redis_password };
    },
  );

  fastify.get<{ Params: { app_id: string } }>(
    '/v1/internal/kv/function-credentials/:app_id',
    async (req, reply) => {
      const cred = await svc.lookup(req.params.app_id);
      if (!cred) return reply.code(404).send({ error: 'no_kv_credential' });
      return {
        app_id: cred.app_id,
        kv_function_key: cred.kv_function_key,
      };
    },
  );

  fastify.post<{ Params: { app_id: string } }>(
    '/v1/internal/kv/credentials/:app_id/rotate',
    async (req, reply) => {
      try {
        const cred = await svc.rotate(req.params.app_id);
        return {
          app_id: cred.app_id,
          redis_password: cred.redis_password,
          rotated_at: cred.rotated_at,
        };
      } catch (err) {
        if (err instanceof Error && /No KV credential/.test(err.message)) {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
    },
  );
};

export default kvCredentialsRoutes;
