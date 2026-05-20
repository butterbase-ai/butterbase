import type { FastifyInstance } from 'fastify';
import { apiError } from '../../utils/api-error.js';
import { z } from 'zod';
import { verifyPassword } from '../../services/auth/password-service.js';
import { getUserByEmail, updateLastSignIn } from '../../services/auth/user-service.js';
import { getOrCreateSigningKey } from '../../services/auth/signing-key-service.js';
import { signAccessToken, createRefreshToken } from '../../services/auth/token-service.js';
import { logAuditEvent } from '../../services/auth/audit-service.js';
import { fireAuthHook } from '../../services/auth/auth-hook-service.js';
import { config } from '../../config.js';
import { resolveAppHomeRegion } from '../../services/region-resolver.js';
import { getRuntimeDbPool } from '../../services/runtime-db.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export async function loginRoutes(app: FastifyInstance) {
  app.post('/auth/:app_id/login', {
    config: {
      public: true,
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
        keyGenerator: (req) => {
          const { app_id } = req.params as { app_id: string };
          return `login:${app_id}:${req.ip}`;
        }
      }
    }
  }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    // Validate request body
    const parseResult = loginSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
        details: parseResult.error.errors,
      });
    }

    const { email, password } = parseResult.data;

    try {
      const region = await resolveAppHomeRegion(app.controlDb, app_id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      // Get user
      const user = await getUserByEmail(app.controlDb, app_id, email);
      if (!user || !user.password_hash) {
        // Log failed login
        await logAuditEvent(runtimeDb, {
          appId: app_id,
          eventType: 'login_failed',
          eventData: { email, reason: 'user_not_found' },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          success: false,
        });
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      // Verify password
      const isValid = await verifyPassword(password, user.password_hash);
      if (!isValid) {
        // Log failed login
        await logAuditEvent(runtimeDb, {
          appId: app_id,
          userId: user.id,
          eventType: 'login_failed',
          eventData: { email, reason: 'invalid_password' },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          success: false,
        });
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      // Get or create signing key for app
      const signingKey = await getOrCreateSigningKey(app.controlDb, app_id);

      // Get JWT config for app
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
          sub: user.id,
          email: user.email,
          app_id,
          email_verified: user.email_verified,
        },
        jwtConfig.accessTokenTtl
      );

      // Create refresh token
      const refreshToken = await createRefreshToken(
        app.controlDb,
        app_id,
        user.id,
        jwtConfig.refreshTokenTtlDays
      );

      // Update last sign-in timestamp (non-blocking)
      updateLastSignIn(app.controlDb, app_id, user.id).catch(() => {});

      // Log successful login (non-blocking)
      logAuditEvent(runtimeDb, {
        appId: app_id,
        userId: user.id,
        eventType: 'login',
        eventData: { email },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        success: true,
      }).catch(() => {});

      // Fire post_auth hook (fire-and-forget)
      fireAuthHook(app.controlDb, app_id, {
        event: 'login',
        user: {
          id: user.id,
          email: user.email,
          provider: 'email',
          display_name: user.display_name,
          avatar_url: user.avatar_url,
        },
        isNewUser: false,
        provider: 'email',
      }, app.log);

      // Convert TTL string to seconds for expires_in
      const ttlMatch = jwtConfig.accessTokenTtl.match(/^(\d+)([smhd])$/);
      let expiresInSeconds = 900; // default 15 minutes
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
          id: user.id,
          email: user.email,
          email_verified: user.email_verified,
          display_name: user.display_name,
          avatar_url: user.avatar_url,
        },
      });
    } catch (error) {
      app.log.error({ error }, 'Login failed');
      return reply.code(500).send(apiError(error, 'Internal server error'));
    }
  });
}
