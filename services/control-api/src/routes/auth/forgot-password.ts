import type { FastifyInstance } from 'fastify';
import { apiError } from '../../utils/api-error.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import { getUserByEmail } from '../../services/auth/user-service.js';
import { sendPasswordResetEmail } from '../../services/auth/email-service.js';
import { logAuditEvent } from '../../services/auth/audit-service.js';
import { config } from '../../config.js';
import { resolveAppHomeRegion } from '../../services/region-resolver.js';
import { getRuntimeDbPool } from '../../services/runtime-db.js';
import { resolveOrgFromApp } from '../../services/app-org-resolver.js';

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export async function forgotPasswordRoutes(app: FastifyInstance) {
  app.post('/auth/:app_id/forgot-password', {
    config: {
      public: true,
      rateLimit: {
        max: 3,
        timeWindow: '15 minutes'
      }
    }
  }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    // Validate request body
    const parseResult = forgotPasswordSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
        details: parseResult.error.errors,
      });
    }

    const { email } = parseResult.data;

    try {
      const region = await resolveAppHomeRegion(app.controlDb, app_id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      // Look up the app's display name so the reset email can use it as the sender.
      const appResult = await runtimeDb.query(
        `SELECT name FROM apps WHERE id = $1`,
        [app_id]
      );
      const appName = (appResult.rows[0]?.name ?? null) as string | null;

      // Look up user (but don't reveal if they exist)
      const user = await getUserByEmail(app.controlDb, app_id, email);

      if (user) {
        // Generate 6-digit reset code
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const codeHash = crypto.createHash('sha256').update(code).digest('hex');

        // Store reset code (expires in 1 hour)
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 1);

        const organizationId = await resolveOrgFromApp(runtimeDb, app_id);

        await runtimeDb.query(
          `INSERT INTO app_verification_codes (app_id, user_id, type, code_hash, expires_at, organization_id)
           VALUES ($1, $2, 'password_reset', $3, $4, $5)`,
          [app_id, user.id, codeHash, expiresAt, organizationId]
        );

        // Send reset email
        await sendPasswordResetEmail(email, code, appName);

        logAuditEvent(runtimeDb, {
          appId: app_id,
          userId: user.id,
          eventType: 'password_reset_requested',
          eventData: { email },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          success: true,
        }).catch(() => {});
      }

      // Always return success (don't leak user existence)
      return reply.send({
        message: 'If an account exists with that email, a password reset code has been sent',
      });
    } catch (error) {
      app.log.error({ error }, 'Forgot password failed');
      return reply.code(500).send(apiError(error, 'Internal server error'));
    }
  });
}
