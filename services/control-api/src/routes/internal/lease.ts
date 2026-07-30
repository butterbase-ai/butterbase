import type { FastifyPluginAsync } from 'fastify';
import { grantLease, settleLease } from '../../services/lease-service.js';

interface GrantBody {
  userId?: string;
  organizationId?: string;
  region?: string;
  amountUsd?: number;
}

interface SettleBody {
  actualUsd?: number;
}

const internalLeaseRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: GrantBody }>('/v1/internal/lease/grant', async (request, reply) => {
    const { userId, organizationId, region, amountUsd } = request.body ?? {};
    if (!userId || !organizationId || !region || typeof amountUsd !== 'number') {
      return reply.code(400).send({ error: 'userId, organizationId, region, amountUsd are required' });
    }
    const ttl = parseInt(process.env.BUTTERBASE_LEASE_TTL_SECONDS ?? '300', 10);
    const result = await grantLease(fastify.controlDb, { userId, organizationId, region, amountUsd, ttlSeconds: ttl });
    return {
      leaseId: result.leaseId,
      amountGranted: result.amountGranted,
      expiresAt: result.expiresAt.toISOString(),
    };
  });

  fastify.post<{ Body: { graceSeconds?: number } }>('/v1/internal/lease/reclaim', async (request) => {
    const { reclaimExpiredLeases } = await import('../../services/lease-reclaim.js');
    const grace = request.body?.graceSeconds ?? 30;
    return reclaimExpiredLeases(fastify.controlDb, grace);
  });

  fastify.post<{ Params: { lease_id: string }; Body: SettleBody }>(
    '/v1/internal/lease/:lease_id/settle',
    async (request, reply) => {
      const { lease_id } = request.params;
      const { actualUsd } = request.body ?? {};
      if (typeof actualUsd !== 'number' || !isFinite(actualUsd) || actualUsd < 0) {
        return reply.code(400).send({ error: 'actualUsd must be a non-negative number' });
      }
      try {
        const result = await settleLease(fastify.controlDb, { leaseId: lease_id, actualUsd });
        return { refundedUsd: result.refundedUsd };
      } catch (err) {
        if (err instanceof Error && /lease not found/.test(err.message)) {
          return reply.code(404).send({ error: 'lease_not_found' });
        }
        throw err;
      }
    }
  );
};

export default internalLeaseRoutes;
