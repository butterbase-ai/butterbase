import type { FastifyInstance } from 'fastify';
import { apiError } from '../../utils/api-error.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import { hashPassword, validatePasswordPolicy } from '../../services/auth/password-service.js';
import { createUser, getUserByEmail } from '../../services/auth/user-service.js';
import { sendVerificationEmail } from '../../services/auth/email-service.js';
import { logAuditEvent } from '../../services/audit/audit-events-service.js';
import { fireAuthHook } from '../../services/auth/auth-hook-service.js';
import { config } from '../../config.js';
import { resolveAppHomeRegion } from '../../services/region-resolver.js';
import { getRuntimeDbPool } from '../../services/runtime-db.js';
import { resolveOrgFromApp } from '../../services/app-org-resolver.js';

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  display_name: z.string().optional(),
});

export async function signupRoutes(app: FastifyInstance) {
  app.post('/auth/:app_id/signup', {
    config: {
      public: true,
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        keyGenerator: (req) => {
          const { app_id } = req.params as { app_id: string };
          return `signup:${app_id}:${req.ip}`;
        }
      }
    }
  }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    // Validate request body
    const parseResult = signupSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
        details: parseResult.error.errors,
      });
    }

    const { email, password, display_name } = parseResult.data;

    let runtimeDb: Awaited<ReturnType<typeof getRuntimeDbPool>> | null = null;
    try {
      const region = await resolveAppHomeRegion(app.controlDb, app_id);
      runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      // Verify app exists
      const appResult = await runtimeDb.query(
        `SELECT id, name FROM apps WHERE id = $1`,
        [app_id]
      );

      if (appResult.rows.length === 0) {
        return reply.code(404).send({ error: 'App not found' });
      }

      const appName = appResult.rows[0].name as string | null;

      // Check if user already exists
      const existingUser = await getUserByEmail(app.controlDb, app_id, email);
      if (existingUser) {
        return reply.code(409).send({ error: 'User already exists' });
      }

      // Validate password policy
      const passwordValidation = validatePasswordPolicy(password);
      if (!passwordValidation.valid) {
        return reply.code(400).send({
          error: 'Password does not meet requirements. Must be at least 8 characters and include: uppercase letter, lowercase letter, number, and special character.',
          details: passwordValidation.errors,
        });
      }

      // Hash password
      const passwordHash = await hashPassword(password);

      // Create user
      const user = await createUser(
        app.controlDb,
        app_id,
        email,
        passwordHash,
        display_name
      );

      // Generate 6-digit verification code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');

      // Store verification code (expires in 24 hours)
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      const organizationId = await resolveOrgFromApp(runtimeDb, app_id);

      await runtimeDb.query(
        `INSERT INTO app_verification_codes (app_id, user_id, type, code_hash, expires_at, organization_id)
         VALUES ($1, $2, 'email_verify', $3, $4, $5)`,
        [app_id, user.id, codeHash, expiresAt, organizationId]
      );

      // Send verification email (non-blocking — don't fail signup if email delivery fails)
      sendVerificationEmail(email, code, appName).catch(err =>
        app.log.warn({ err, email, app_id }, 'Verification email failed to send')
      );

      // Log successful signup (non-blocking)
      void logAuditEvent(runtimeDb, {
        appId: app_id,
        category: 'auth',
        eventType: 'signup',
        action: 'create',
        resourceType: 'app_user',
        resourceId: user.id,
        actorType: 'anonymous',
        actorId: null,
        eventData: { email, provider: 'email' },
        ipAddress: request.ip ?? null,
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        success: true,
      });

      // Emit platform event for cloud-side fan-out (substrate auto-mirror etc.)
      app.platformEventBus.emit('auth.signup.completed', {
        appId: app_id,
        userId: user.id,
        email: user.email,
        displayName: user.display_name,
        provider: 'email',
        runtimeDb,
      });

      // Fire post_auth hook (fire-and-forget)
      fireAuthHook(app.controlDb, app_id, {
        event: 'signup',
        user: {
          id: user.id,
          email: user.email,
          provider: 'email',
          display_name: user.display_name,
        },
        isNewUser: true,
        provider: 'email',
      }, app.log);

      return reply.code(201).send({
        user: {
          id: user.id,
          email: user.email,
          email_verified: user.email_verified,
          display_name: user.display_name,
        },
        message: 'Verification email sent',
      });
    } catch (error) {
      // Log failed signup (non-blocking). If runtimeDb wasn't resolved
      // (the home-region lookup itself threw), skip the audit write.
      if (runtimeDb) {
        void logAuditEvent(runtimeDb, {
          appId: app_id,
          category: 'auth',
          eventType: 'signup_failed',
          action: 'create',
          resourceType: 'app_user',
          actorType: 'anonymous',
          actorId: null,
          eventData: { email },
          ipAddress: request.ip ?? null,
          userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
          success: false,
          errorMessage: (error as Error).message,
        });
      }

      app.log.error({ error }, 'Signup failed');
      return reply.code(500).send(apiError(error, 'Internal server error'));
    }
  });
}
