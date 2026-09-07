import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUserId } from '../utils/require-auth.js';
import { isHttpError } from '../services/error-handler.js';
import { apiError } from '../utils/api-error.js';
import {
  DEFAULT_AUTO_REFILL_THRESHOLD_USD,
  MIN_AUTO_REFILL_THRESHOLD_USD,
  MAX_AUTO_REFILL_THRESHOLD_USD,
} from '../services/auto-refill-service.js';

const putSchema = z.object({
  enabled: z.boolean(),
  amount_usd: z.number().min(5).max(500).nullable().optional(),
  // Omitted -> leave the stored threshold alone. Explicit null -> clear it and
  // fall back to the service default. The two are distinct on purpose: a
  // client that only toggles `enabled` must not silently reset the trigger.
  threshold_usd: z
    .number()
    .min(MIN_AUTO_REFILL_THRESHOLD_USD)
    .max(MAX_AUTO_REFILL_THRESHOLD_USD)
    .nullable()
    .optional(),
});

export async function autoRefillRoutes(app: FastifyInstance) {
  app.get('/v1/users/me/auto-refill', async (request, reply) => {
    const userId = requireUserId(request);
    try {
      const r = await app.controlDb.query<{
        auto_refill_enabled: boolean;
        auto_refill_amount_usd: string | null;
        auto_refill_threshold_usd: string | null;
        auto_refill_last_attempt_at: Date | null;
        auto_refill_last_failure_reason: string | null;
      }>(
        `SELECT o.auto_refill_enabled, o.auto_refill_amount_usd,
                o.auto_refill_threshold_usd,
                o.auto_refill_last_attempt_at, o.auto_refill_last_failure_reason
         FROM organizations o
         JOIN platform_users u ON u.personal_organization_id = o.id
         WHERE u.id = $1`,
        [userId]
      );
      if (r.rows.length === 0) {
        return reply.code(404).send({ error: 'user_not_found' });
      }
      const row = r.rows[0];
      const configured = row.auto_refill_threshold_usd != null
        ? parseFloat(row.auto_refill_threshold_usd)
        : null;
      return {
        enabled: row.auto_refill_enabled,
        amount_usd: row.auto_refill_amount_usd != null ? parseFloat(row.auto_refill_amount_usd) : null,
        // `threshold_usd` is what the org actually set (null = never set);
        // `effective_threshold_usd` is the number the service will compare
        // against, so a client can render "we charge below $X" without having
        // to know the default. Both, because collapsing them would hide
        // whether the value was chosen or inherited.
        threshold_usd: configured,
        effective_threshold_usd: configured ?? DEFAULT_AUTO_REFILL_THRESHOLD_USD,
        threshold_min_usd: MIN_AUTO_REFILL_THRESHOLD_USD,
        threshold_max_usd: MAX_AUTO_REFILL_THRESHOLD_USD,
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
          `SELECT o.stripe_customer_id
           FROM organizations o
           JOIN platform_users u ON u.personal_organization_id = o.id
           WHERE u.id = $1`,
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

      // `threshold_usd` absent from the body leaves the column untouched —
      // hence the COALESCE against a sentinel rather than a plain assignment.
      const thresholdProvided = Object.prototype.hasOwnProperty.call(
        request.body as object,
        'threshold_usd',
      );
      await app.controlDb.query(
        `UPDATE organizations SET
           auto_refill_enabled = $1,
           auto_refill_amount_usd = $2,
           auto_refill_threshold_usd = CASE WHEN $4 THEN $5 ELSE auto_refill_threshold_usd END,
           auto_refill_last_failure_reason = CASE WHEN $1 THEN NULL ELSE auto_refill_last_failure_reason END
         WHERE id = (SELECT personal_organization_id FROM platform_users WHERE id = $3)`,
        [body.enabled, body.amount_usd ?? null, userId, thresholdProvided, body.threshold_usd ?? null]
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
