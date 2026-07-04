import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { sendInviteEmail } from '../services/auth/email-service.js';

interface InviteEmailBody {
  toEmail: string;
  orgName: string;
  inviterEmail: string;
  inviteUrl: string;
  expiresAt: string; // ISO-8601 string; parsed to Date before calling sendInviteEmail
}

/**
 * Internal service-to-service endpoint for dispatching invite emails.
 * Protected by X-Internal-Secret (timing-safe comparison).
 * Returns 202 immediately; sendInviteEmail is fire-and-forget.
 */
export const internalEmailRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: InviteEmailBody }>(
    '/internal/email/invite',
    {
      schema: {
        body: {
          type: 'object',
          required: ['toEmail', 'orgName', 'inviterEmail', 'inviteUrl', 'expiresAt'],
          properties: {
            toEmail: { type: 'string', minLength: 1 },
            orgName: { type: 'string', minLength: 1 },
            inviterEmail: { type: 'string', minLength: 1 },
            inviteUrl: { type: 'string', minLength: 1 },
            expiresAt: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      // Timing-safe auth check
      const got = request.headers['x-internal-secret'];
      const expected = config.internal.emailSecret;
      if (typeof got !== 'string' || !timingSafeEqual(
        Buffer.from(createHash('sha256').update(got).digest()),
        Buffer.from(createHash('sha256').update(expected).digest()),
      )) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const { toEmail, orgName, inviterEmail, inviteUrl, expiresAt } = request.body;

      const expiresAtDate = new Date(expiresAt);
      if (isNaN(expiresAtDate.getTime())) {
        return reply.code(400).send({ error: 'expiresAt must be a valid ISO-8601 date string' });
      }

      // Fire-and-forget — do not await; invite row is already committed
      void sendInviteEmail({ toEmail, orgName, inviterEmail, inviteUrl, expiresAt: expiresAtDate });

      return reply.code(202).send({ queued: true });
    }
  );
};
