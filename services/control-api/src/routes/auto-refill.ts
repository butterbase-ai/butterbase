import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUserId } from '../utils/require-auth.js';
import { isHttpError } from '../services/error-handler.js';
import { apiError } from '../utils/api-error.js';

const putSchema = z.object({
  enabled: z.boolean(),
  amount_usd: z.number().min(5).max(500).nullable().optional(),
});

export async function autoRefillRoutes(app: FastifyInstance) {
  app.get('/v1/users/me/auto-refill', async (request, reply) => {
    const userId = requireUserId(request);
    try {
      const r = await app.controlDb.query<{
        auto_refill_enabled: boolean;
        auto_refill_amount_usd: string | null;
        auto_refill_last_attempt_at: Date | null;
        auto_refill_last_failure_reason: string | null;
      }>(
        `SELECT auto_refill_enabled, auto_refill_amount_usd,
                auto_refill_last_attempt_at, auto_refill_last_failure_reason
         FROM platform_users WHERE id = $1`,
        [userId]
      );
      if (r.rows.length === 0) {
        return reply.code(404).send({ error: 'user_not_found' });
      }
      const row = r.rows[0];
      return {
        enabled: row.auto_refill_enabled,
        amount_usd: row.auto_refill_amount_usd != null ? parseFloat(row.auto_refill_amount_usd) : null,
        last_attempt_at: row.auto_refill_last_attempt_at,
        last_failure_reason: row.auto_refill_last_failure_reason,
      };
    } catch (error) {
      if (isHttpError(error)) throw error;
      app.log.error({ err: error }, 'Failed to read auto-refill state');
      return reply.code(500).send(apiError(error, 'Failed to read auto-refill state'));
    }
  });

  app.put('/v1/users/me/auto-refill', async (request, reply) => {
    const userId = requireUserId(request);
    try {
      const body = putSchema.parse(request.body);

      if (body.enabled) {
        if (body.amount_usd == null) {
          return reply.code(400).send({ error: 'amount_required', code: 'AMOUNT_REQUIRED' });
        }
        const cust = await app.controlDb.query<{ stripe_customer_id: string | null }>(
          `SELECT stripe_customer_id FROM platform_users WHERE id = $1`,
          [userId]
        );
        if (!cust.rows[0]?.stripe_customer_id) {
          return reply.code(400).send({
            error: 'no_payment_method',
            code: 'NO_PAYMENT_METHOD',
            message: 'Set up a payment method before enabling auto-refill.',
          });
        }
      }

      await app.controlDb.query(
        `UPDATE platform_users
           SET auto_refill_enabled = $1,
               auto_refill_amount_usd = $2,
               auto_refill_last_failure_reason = CASE WHEN $1 THEN NULL ELSE auto_refill_last_failure_reason END
         WHERE id = $3`,
        [body.enabled, body.amount_usd ?? null, userId]
      );

      // Audit events deferred — see auto-refill-service.ts header comment.
      // Auto-refill is a user-level operation; AuditEventInput requires
      // appId (NOT NULL) and a resourceType from a closed union that doesn't
      // include `auto_refill`. The durable records (auto_refill_enabled flag
      // + auto_refill_last_*) already capture state changes.

      return { ok: true };
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'invalid_request', details: error.errors });
      }
      app.log.error({ err: error }, 'Failed to update auto-refill');
      return reply.code(500).send(apiError(error, 'Failed to update auto-refill'));
    }
  });
}
