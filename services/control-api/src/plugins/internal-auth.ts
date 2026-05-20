import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

const internalAuthPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/internal/')) return;
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
