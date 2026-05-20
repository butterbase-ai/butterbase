import type { FastifyInstance } from 'fastify';
import { apiError } from '../../utils/api-error.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import { hashPassword, validatePasswordPolicy } from '../../services/auth/password-service.js';
import { updatePassword } from '../../services/auth/user-service.js';
import { revokeAllRefreshTokens } from '../../services/auth/token-service.js';
import { logAuditEvent } from '../../services/auth/audit-service.js';
import { config } from '../../config.js';
import { resolveAppHomeRegion } from '../../services/region-resolver.js';
import { getRuntimeDbPool } from '../../services/runtime-db.js';

const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
  new_password: z.string().min(8),
});

export async function resetPasswordRoutes(app: FastifyInstance) {
  app.post('/auth/:app_id/reset-password', {
    config: {
      public: true,
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes'
      }
    }
  }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    // Validate request body
    const parseResult = resetPasswordSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
        details: parseResult.error.errors,
      });
    }

    const { email, code, new_password } = parseResult.data;

    try {
      const region = await resolveAppHomeRegion(app.controlDb, app_id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      // Hash the code
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');

      // Look up reset code
      const result = await runtimeDb.query(
        `SELECT vc.id, vc.user_id, vc.expires_at, vc.used_at, u.email
         FROM app_verification_codes vc
         JOIN app_users u ON vc.user_id = u.id
         WHERE vc.app_id = $1 AND u.email = $2 AND vc.type = 'password_reset' AND vc.code_hash = $3`,
        [app_id, email, codeHash]
      );

      if (result.rows.length === 0) {
        return reply.code(400).send({ error: 'Invalid reset code' });
      }

      const row = result.rows[0];

      // Check if already used
      if (row.used_at) {
        return reply.code(400).send({ error: 'Reset code already used' });
      }

      // Check if expired
      if (new Date(row.expires_at) < new Date()) {
        return reply.code(400).send({ error: 'Reset code expired' });
      }

      // Mark code as used
      await runtimeDb.query(
        `UPDATE app_verification_codes SET used_at = now() WHERE id = $1`,
        [row.id]
      );

      // Validate password policy
      const passwordValidation = validatePasswordPolicy(new_password);
      if (!passwordValidation.valid) {
        return reply.code(400).send({
          error: 'Password does not meet requirements. Must be at least 8 characters and include: uppercase letter, lowercase letter, number, and special character.',
          details: passwordValidation.errors,
        });
      }

      // Hash new password
      const passwordHash = await hashPassword(new_password);

      // Update password
      await updatePassword(app.controlDb, app_id, row.user_id, passwordHash);

      // Revoke all refresh tokens (force re-login)
      await revokeAllRefreshTokens(app.controlDb, app_id, row.user_id);

      logAuditEvent(runtimeDb, {
        appId: app_id,
        userId: row.user_id,
        eventType: 'password_reset_completed',
        eventData: { email },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        success: true,
      }).catch(() => {});

      return reply.send({ message: 'Password reset successfully' });
    } catch (error) {
      app.log.error({ error }, 'Password reset failed');
      return reply.code(500).send(apiError(error, 'Internal server error'));
    }
  });
}
