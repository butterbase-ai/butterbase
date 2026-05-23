import type { FastifyPluginAsync } from 'fastify';
import { verifyEndUserJwt } from '../../services/end-user-auth.js';
import { KvCredentialsService } from '../../services/kv-credentials.js';

const kvResolveJwtRoutes: FastifyPluginAsync = async (fastify) => {
  const svc = new KvCredentialsService(fastify.controlDb);

  fastify.post<{ Body: { jwt: string; app_id: string } }>(
    '/v1/internal/kv/resolve-jwt',
    async (req, reply) => {
      const { jwt, app_id: appId } = req.body ?? {};
      if (!jwt || !appId) return reply.code(400).send({ error: 'missing_fields' });

      let claims;
      try {
        claims = await verifyEndUserJwt(fastify.controlDb, appId, jwt);
      } catch {
        return reply.code(401).send({ error: 'invalid_jwt' });
      }

      const cred = await svc.lookup(appId);
      if (!cred) return reply.code(404).send({ error: 'no_kv_credential' });

      return {
        app_id: cred.app_id,
        region: cred.region,
        redis_password: cred.redis_password,
        user_id: String(claims.sub ?? ''),
        role: (claims as { role?: string | null }).role ?? null,
      };
    },
  );
};

export default kvResolveJwtRoutes;
