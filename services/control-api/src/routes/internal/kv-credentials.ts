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

  fastify.post<{ Body: { api_key: string } }>(
    '/v1/internal/kv/resolve-key',
    async (req, reply) => {
      const rawKey = req.body?.api_key;
      if (!rawKey) return reply.code(400).send({ error: 'api_key required' });

      // Hash the key and join to apps + kv credentials in one query.
      // api_keys is user-scoped (user_id), so we join through apps.owner_id.
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const { rows } = await fastify.controlDb.query<{
        app_id: string;
        region: string;
        redis_password: string;
      }>(
        `SELECT kv.app_id, kv.region, kv.redis_password
         FROM api_keys ak
         JOIN apps a ON a.owner_id = ak.user_id
         JOIN app_kv_credentials kv ON kv.app_id = a.id
         WHERE ak.key_hash = $1
           AND ak.revoked_at IS NULL
           AND (ak.expires_at IS NULL OR ak.expires_at > now())
         LIMIT 1`,
        [keyHash],
      );

      if (rows.length === 0) return reply.code(404).send({ error: 'invalid_key' });
      const row = rows[0];
      return { app_id: row.app_id, region: row.region, redis_password: row.redis_password };
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
