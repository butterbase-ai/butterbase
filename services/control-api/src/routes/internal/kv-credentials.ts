import crypto from 'crypto';
import type { FastifyPluginAsync } from 'fastify';
import { KvCredentialsService } from '../../services/kv-credentials.js';

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

      // Hash the key and look up the specific app in one query.
      // We join api_keys → apps (filtered by the requested app_id AND owner_id match) → kv credentials.
      // This validates: key is valid, key's user owns the requested app, and a KV credential exists.
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const { rows } = await fastify.controlDb.query<{
        app_id: string;
        region: string;
        redis_password: string;
        key_valid: boolean;
        owns_app: boolean;
      }>(
        `SELECT
           ak.user_id IS NOT NULL AS key_valid,
           a.id IS NOT NULL AS owns_app,
           kv.app_id,
           kv.region,
           kv.redis_password
         FROM api_keys ak
         LEFT JOIN apps a ON a.id = $2 AND a.owner_id = ak.user_id
         LEFT JOIN app_kv_credentials kv ON kv.app_id = a.id
         WHERE ak.key_hash = $1
           AND ak.revoked_at IS NULL
           AND (ak.expires_at IS NULL OR ak.expires_at > now())
         LIMIT 1`,
        [keyHash, appId],
      );

      if (rows.length === 0) {
        // Fallback: per-app function key (auto-injected into deno-runtime).
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
      }
      const row = rows[0];
      if (!row.owns_app) return reply.code(403).send({ error: 'forbidden' });
      if (!row.app_id) return reply.code(404).send({ error: 'no_kv_credential' });
      return { app_id: row.app_id, region: row.region, redis_password: row.redis_password };
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
