import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { revokeAllRefreshTokens, verifyAccessToken } from '../../services/auth/token-service.js';
import { getOrCreateSigningKey } from '../../services/auth/signing-key-service.js';
import { logAuditEvent } from '../../services/auth/audit-service.js';

export async function logoutRoutes(app: FastifyInstance) {
  app.post('/auth/:app_id/logout', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    try {
      // Extract and verify access token
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
      }

      const token = authHeader.substring(7);

      // Get signing key to verify token
      const signingKey = await getOrCreateSigningKey(app.controlDb, app_id);
      const publicKey = crypto.createPublicKey(signingKey.publicKey);

      // Verify token
      const claims = await verifyAccessToken(publicKey, token, app_id);

      // Revoke all refresh tokens for this user
      await revokeAllRefreshTokens(app.controlDb, app_id, claims.sub);

      logAuditEvent(app.controlDb, {
        appId: app_id,
        userId: claims.sub,
        eventType: 'logout',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        success: true,
      }).catch(() => {});

      return reply.send({ message: 'Logged out successfully' });
    } catch (error) {
      logAuditEvent(app.controlDb, {
        appId: app_id,
        eventType: 'logout',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        success: false,
        errorMessage: (error as Error).message,
      }).catch(() => {});
      // Logout returns 401 for any verification error — routine client condition.
      app.log.warn({ err: error }, 'Logout failed');
      return reply.code(401).send({ error: 'Invalid token' });
    }
  });
}
