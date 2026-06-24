import type { FastifyInstance } from 'fastify';
import { apiError } from '../../utils/api-error.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import { getUserByEmailAnyProvider, createUser, markEmailVerified, updateLastSignIn } from '../../services/auth/user-service.js';
import { getOrCreateSigningKey } from '../../services/auth/signing-key-service.js';
import { signAccessToken, createRefreshToken } from '../../services/auth/token-service.js';
import { sendMagicLinkEmail } from '../../services/auth/email-service.js';
import { logAuditEvent } from '../../services/audit/audit-events-service.js';
import { fireAuthHook } from '../../services/auth/auth-hook-service.js';
import { config } from '../../config.js';
import { resolveAppHomeRegion } from '../../services/region-resolver.js';
import { getRuntimeDbPool } from '../../services/runtime-db.js';

const sendSchema = z.object({
  email: z.string().email(),
});

const verifySchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

export async function magicLinkRoutes(app: FastifyInstance) {
  // POST /auth/:app_id/magic-link — send a magic-link code
  app.post('/auth/:app_id/magic-link', {
    config: {
      public: true,
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        keyGenerator: (req: any) => {
          const { app_id } = req.params as { app_id: string };
          return `magic_link:${app_id}:${req.ip}`;
        }
      }
    }
  }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    const parseResult = sendSchema.safeParse(request.body);
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
      // Verify app exists
      const appResult = await runtimeDb.query(
        `SELECT id, name FROM apps WHERE id = $1`,
        [app_id]
      );
      if (appResult.rows.length === 0) {
        return reply.code(404).send({ error: 'App not found' });
      }

      const appName = appResult.rows[0].name as string | null;

      // Get or auto-create user (frictionless signup+login)
      let user = await getUserByEmailAnyProvider(app.controlDb, app_id, email);
      let isNewUser = false;

      if (!user) {
        try {
          user = await createUser(app.controlDb, app_id, email, null);
          isNewUser = true;

          app.platformEventBus.emit('auth.signup.completed', {
            appId: app_id,
            userId: user.id,
            email, // raw input from parseResult.data
            displayName: null, // createUser called without display_name
            provider: 'magic_link',
            runtimeDb,
          });
        } catch (err: any) {
          // Handle race condition: concurrent magic-link requests for same email
          if (err.code === '23505') {
            user = await getUserByEmailAnyProvider(app.controlDb, app_id, email);
          }
          if (!user) throw err;
        }
      }

      // Generate 6-digit code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');

      // Store code (expires in 15 minutes)
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 15);

      await runtimeDb.query(
        `INSERT INTO app_verification_codes (app_id, user_id, type, code_hash, expires_at)
         VALUES ($1, $2, 'magic_link', $3, $4)`,
        [app_id, user.id, codeHash, expiresAt]
      );

      // Send email (non-blocking)
      sendMagicLinkEmail(email, code, appName).catch(err =>
        app.log.warn({ err, email, app_id }, 'Magic-link email failed to send')
      );

      // Audit log (non-blocking)
      void logAuditEvent(runtimeDb, {
        appId: app_id,
        category: 'auth',
        eventType: 'magic_link_requested',
        action: 'create',
        resourceType: 'app_user',
        resourceId: user.id,
        actorType: 'anonymous',
        actorId: null,
        eventData: { email, isNewUser },
        ipAddress: request.ip ?? null,
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        success: true,
      });

      // Always return success (don't leak user existence)
      return reply.send({
        message: 'If an account exists with that email, a sign-in code has been sent',
      });
    } catch (error) {
      app.log.error({ error }, 'Magic-link send failed');
      return reply.code(500).send(apiError(error, 'Internal server error'));
    }
  });

  // POST /auth/:app_id/magic-link/verify — verify code, issue tokens
  app.post('/auth/:app_id/magic-link/verify', {
    config: {
      public: true,
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
        keyGenerator: (req: any) => {
          const { app_id } = req.params as { app_id: string };
          return `magic_link_verify:${app_id}:${req.ip}`;
        }
      }
    }
  }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    const parseResult = verifySchema.safeParse(request.body);
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
      // Hash the code and look up
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');

      const result = await runtimeDb.query(
        `SELECT vc.id, vc.user_id, vc.expires_at, vc.used_at, u.email, u.created_at as user_created_at
         FROM app_verification_codes vc
         JOIN app_users u ON vc.user_id = u.id
         WHERE vc.app_id = $1 AND u.email = $2 AND vc.type = 'magic_link' AND vc.code_hash = $3`,
        [app_id, email, codeHash]
      );

      if (result.rows.length === 0) {
        return reply.code(400).send({ error: 'Invalid sign-in code' });
      }

      const row = result.rows[0];

      if (row.used_at) {
        return reply.code(400).send({ error: 'Sign-in code already used' });
      }

      if (new Date(row.expires_at) < new Date()) {
        return reply.code(400).send({ error: 'Sign-in code expired' });
      }

      // Mark code as used
      await runtimeDb.query(
        `UPDATE app_verification_codes SET used_at = now() WHERE id = $1`,
        [row.id]
      );

      // Mark email as verified
      await markEmailVerified(app.controlDb, app_id, row.user_id);

      // Get or create signing key
      const signingKey = await getOrCreateSigningKey(app.controlDb, app_id);

      // Get JWT config
      const appConfigResult = await runtimeDb.query(
        `SELECT jwt_config FROM apps WHERE id = $1`,
        [app_id]
      );
      const jwtConfig = appConfigResult.rows[0]?.jwt_config || {
        accessTokenTtl: '1h',
        refreshTokenTtlDays: 7
      };

      // Sign access token
      const accessToken = await signAccessToken(
        signingKey.privateKey,
        signingKey.kid,
        {
          sub: row.user_id,
          email: row.email,
          app_id,
          email_verified: true,
        },
        jwtConfig.accessTokenTtl
      );

      // Create refresh token
      const refreshToken = await createRefreshToken(
        app.controlDb,
        app_id,
        row.user_id,
        jwtConfig.refreshTokenTtlDays
      );

      // Update last sign-in (non-blocking)
      updateLastSignIn(app.controlDb, app_id, row.user_id).catch(() => {});

      // Determine if this is a new user (created within last 2 minutes — covers the auto-create window)
      const isNewUser = (Date.now() - new Date(row.user_created_at).getTime()) < 120_000;

      // Audit log (non-blocking)
      void logAuditEvent(runtimeDb, {
        appId: app_id,
        category: 'auth',
        eventType: 'magic_link_login',
        action: 'create',
        resourceType: 'app_user',
        resourceId: row.user_id,
        actorType: 'app_user',
        actorId: row.user_id,
        eventData: { email, isNewUser },
        ipAddress: request.ip ?? null,
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        success: true,
      });

      // Fire auth hook (fire-and-forget)
      fireAuthHook(app.controlDb, app_id, {
        event: 'magic_link_login',
        user: {
          id: row.user_id,
          email: row.email,
          provider: 'magic_link',
          display_name: null,
        },
        isNewUser,
        provider: 'magic_link',
      }, app.log);

      // Convert TTL string to seconds for expires_in
      const ttlMatch = jwtConfig.accessTokenTtl.match(/^(\d+)([smhd])$/);
      let expiresInSeconds = 900;
      if (ttlMatch) {
        const value = parseInt(ttlMatch[1]);
        const unit = ttlMatch[2] as 's' | 'm' | 'h' | 'd';
        const multipliers: Record<'s' | 'm' | 'h' | 'd', number> = { s: 1, m: 60, h: 3600, d: 86400 };
        expiresInSeconds = value * multipliers[unit];
      }

      return reply.send({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: expiresInSeconds,
        token_type: 'Bearer',
        user: {
          id: row.user_id,
          email: row.email,
          email_verified: true,
          display_name: null,
          avatar_url: null,
        },
      });
    } catch (error) {
      app.log.error({ error }, 'Magic-link verify failed');
      return reply.code(500).send(apiError(error, 'Internal server error'));
    }
  });
}
