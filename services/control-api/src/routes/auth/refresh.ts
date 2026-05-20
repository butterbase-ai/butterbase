import type { FastifyInstance } from 'fastify';
import { apiError } from '../../utils/api-error.js';
import { z } from 'zod';
import { consumeRefreshToken, createRefreshToken, signAccessToken } from '../../services/auth/token-service.js';
import { getOrCreateSigningKey } from '../../services/auth/signing-key-service.js';
import { getUserById } from '../../services/auth/user-service.js';
import { logAuditEvent } from '../../services/auth/audit-service.js';
import { config } from '../../config.js';
import { resolveAppHomeRegion } from '../../services/region-resolver.js';
import { getRuntimeDbPool } from '../../services/runtime-db.js';

const refreshSchema = z.object({
  refresh_token: z.string(),
});

export async function refreshRoutes(app: FastifyInstance) {
  app.post('/auth/:app_id/refresh', {
    config: {
      public: true,
      rateLimit: {
        max: 20,
        timeWindow: '15 minutes'
      }
    }
  }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    // Validate request body
    const parseResult = refreshSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
        details: parseResult.error.errors,
      });
    }

    const { refresh_token } = parseResult.data;

    try {
      const region = await resolveAppHomeRegion(app.controlDb, app_id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      // Consume old refresh token (validates and revokes it)
      const tokenData = await consumeRefreshToken(app.controlDb, app_id, refresh_token);
      if (!tokenData) {
        logAuditEvent(runtimeDb, {
          appId: app_id,
          eventType: 'refresh_token_failed',
          eventData: { reason: 'invalid_or_expired' },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          success: false,
        }).catch(() => {});
        return reply.code(401).send({ error: 'Invalid or expired refresh token' });
      }

      // Verify app_id matches
      if (tokenData.appId !== app_id) {
        logAuditEvent(runtimeDb, {
          appId: app_id,
          userId: tokenData.userId,
          eventType: 'refresh_token_failed',
          eventData: { reason: 'app_id_mismatch' },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          success: false,
        }).catch(() => {});
        return reply.code(401).send({ error: 'Invalid refresh token' });
      }

      // Get user details
      const user = await getUserById(app.controlDb, app_id, tokenData.userId);
      if (!user) {
        return reply.code(401).send({ error: 'User not found' });
      }

      // Get signing key
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

      // Sign new access token
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

      // Create new refresh token (token rotation)
      const newRefreshToken = await createRefreshToken(
        app.controlDb,
        app_id,
        user.id,
        jwtConfig.refreshTokenTtlDays
      );

      // Convert TTL string to seconds for expires_in
      const ttlMatch = jwtConfig.accessTokenTtl.match(/^(\d+)([smhd])$/);
      let expiresInSeconds = 900; // default 15 minutes
      if (ttlMatch) {
        const value = parseInt(ttlMatch[1]);
        const unit = ttlMatch[2] as 's' | 'm' | 'h' | 'd';
        const multipliers: Record<'s' | 'm' | 'h' | 'd', number> = { s: 1, m: 60, h: 3600, d: 86400 };
        expiresInSeconds = value * multipliers[unit];
      }

      logAuditEvent(runtimeDb, {
        appId: app_id,
        userId: user.id,
        eventType: 'refresh_token_used',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        success: true,
      }).catch(() => {});

      return reply.send({
        access_token: accessToken,
        refresh_token: newRefreshToken,
        expires_in: expiresInSeconds,
        token_type: 'Bearer',
      });
    } catch (error) {
      app.log.error({ error }, 'Token refresh failed');
      return reply.code(500).send(apiError(error, 'Internal server error'));
    }
  });
}
