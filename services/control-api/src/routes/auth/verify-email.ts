import type { FastifyInstance } from 'fastify';
import { apiError } from '../../utils/api-error.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import { markEmailVerified } from '../../services/auth/user-service.js';
import { logAuditEvent } from '../../services/auth/audit-service.js';
import { config } from '../../config.js';
import { resolveAppHomeRegion } from '../../services/region-resolver.js';
import { getRuntimeDbPool } from '../../services/runtime-db.js';

const verifyEmailSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

export async function verifyEmailRoutes(app: FastifyInstance) {
  app.post('/auth/:app_id/verify-email', {
    config: {
      public: true,
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes'
      }
    }
  }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    // Validate request body
    const parseResult = verifyEmailSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
        details: parseResult.error.errors,
      });
    }

    const { email, code } = parseResult.data;

    try {
      const region = await resolveAppHomeRegion(app.controlDb, app_id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      // Hash the code
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');

      // Look up verification code
      const result = await runtimeDb.query(
        `SELECT vc.id, vc.user_id, vc.expires_at, vc.used_at, u.email
         FROM app_verification_codes vc
         JOIN app_users u ON vc.user_id = u.id
         WHERE vc.app_id = $1 AND u.email = $2 AND vc.type = 'email_verify' AND vc.code_hash = $3`,
        [app_id, email, codeHash]
      );

      if (result.rows.length === 0) {
        return reply.code(400).send({ error: 'Invalid verification code' });
      }

      const row = result.rows[0];

      // Check if already used
      if (row.used_at) {
        return reply.code(400).send({ error: 'Verification code already used' });
      }

      // Check if expired
      if (new Date(row.expires_at) < new Date()) {
        return reply.code(400).send({ error: 'Verification code expired' });
      }

      // Mark code as used
      await runtimeDb.query(
        `UPDATE app_verification_codes SET used_at = now() WHERE id = $1`,
        [row.id]
      );

      // Mark email as verified
      await markEmailVerified(app.controlDb, app_id, row.user_id);

      app.platformEventBus.emit('auth.email.verified', {
        appId: app_id,
        userId: row.user_id,
        email: row.email,
        runtimeDb,
      });

      logAuditEvent(runtimeDb, {
        appId: app_id,
        userId: row.user_id,
        eventType: 'email_verified',
        eventData: { email },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        success: true,
      }).catch(() => {});

      return reply.send({ message: 'Email verified successfully' });
    } catch (error) {
      app.log.error({ error }, 'Email verification failed');
      return reply.code(500).send(apiError(error, 'Internal server error'));
    }
  });
}
