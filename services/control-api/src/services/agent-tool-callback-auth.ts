import type { FastifyRequest, FastifyReply } from 'fastify';

export async function requireInternalServiceToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Read from process.env at call-time so tests can override the value
  // without requiring module re-loading (config is frozen at import time).
  // Accept BUTTERBASE_INTERNAL_SECRET as a fallback to stay in sync with
  // agent-runtime's config (services/agent-runtime/src/agent_runtime/config.py).
  const expected =
    process.env.INTERNAL_SERVICE_TOKEN ||
    process.env.BUTTERBASE_INTERNAL_SECRET ||
    '';
  const header = request.headers['x-internal-service-token'];
  if (!expected || typeof header !== 'string' || header !== expected) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}
