import type { FastifyRequest, FastifyReply } from 'fastify';

export async function requireInternalServiceToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Read from process.env at call-time so tests can override the value
  // without requiring module re-loading (config is frozen at import time).
  const expected = process.env.INTERNAL_SERVICE_TOKEN ?? '';
  const header = request.headers['x-internal-service-token'];
  if (typeof header !== 'string' || header !== expected) {
    reply.code(401).send({ error: 'unauthorized' });
  }
}
