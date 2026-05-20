import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { verifyAccessToken } from '../../services/auth/token-service.js';
import { getOrCreateSigningKey } from '../../services/auth/signing-key-service.js';
import { getUserById } from '../../services/auth/user-service.js';

export async function meRoutes(app: FastifyInstance) {
  app.get('/auth/:app_id/me', async (request, reply) => {
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

      // Get user details
      const user = await getUserById(app.controlDb, app_id, claims.sub);
      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      return {
        id: user.id,
        email: user.email,
        email_verified: user.email_verified,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        provider: user.provider,
        created_at: user.created_at,
        last_sign_in_at: user.last_sign_in_at,
      };
    } catch (error) {
      // The route only does token verification + a single user lookup — all errors
      // here translate to a 401 from the client's perspective. Log at warn so
      // routine token-expiry doesn't pollute platform alerting.
      app.log.warn({ err: error }, 'Get user profile failed');
      return reply.code(401).send({ error: 'Invalid token' });
    }
  });
}
