import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

const internalAuthPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/internal/')) return;
    // The kv-proxy route does its own bearer-key auth; skip the shared-secret check for it.
    if (request.url.startsWith('/v1/internal/kv/proxy/')) return;
    const secret = process.env.BUTTERBASE_INTERNAL_SECRET;
    if (!secret) {
      return reply.code(500).send({ error: 'BUTTERBASE_INTERNAL_SECRET not configured' });
    }
    const got = request.headers['x-butterbase-internal-secret'];
    if (got !== secret) {
      return reply.code(401).send({ error: 'unauthorized internal call' });
    }
  });
};

export default fp(internalAuthPlugin, { name: 'internal-auth' });
