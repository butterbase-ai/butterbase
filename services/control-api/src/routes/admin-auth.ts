import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthProvider } from '../services/auth-provider.js';
import { CognitoAuthProvider } from '../services/cognito-auth-provider.js';
import { LocalAuthProvider } from '../services/local-auth-provider.js';
import { config } from '../config.js';
import { recordPlatformUserLogin } from '../services/activity-service.js';

// Use the same auth provider as the main auth plugin
const authProvider: AuthProvider = config.cognito.userPoolId
  ? new CognitoAuthProvider(
      config.cognito.userPoolId,
      config.cognito.clientId,
      config.cognito.region
    )
  : new LocalAuthProvider(config.auth.jwtSecret);

export async function adminAuthRoutes(app: FastifyInstance) {
  // GET /admin/me — verify Cognito JWT + check is_admin
  app.get('/admin/me', { config: { public: true } }, async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing authorization' });
    }

    try {
      const token = authHeader.substring(7);
      const claims = await authProvider.verifyJwt(token);

      // Look up user by cognito_sub and check is_admin
      const result = await app.controlDb.query(
        'SELECT id, email, display_name, is_admin, last_login_at FROM platform_users WHERE cognito_sub = $1',
        [claims.sub]
      );

      const user = result.rows[0];
      if (!user) {
        return reply.code(403).send({ error: 'User not found in platform' });
      }

      if (!user.is_admin) {
        return reply.code(403).send({ error: 'Not authorized as admin' });
      }

      // Throttle: only re-record if we haven't seen this admin in 5 minutes.
      const LOGIN_RECORD_INTERVAL_MS = 5 * 60_000;
      const lastLogin = user.last_login_at ? new Date(user.last_login_at).getTime() : 0;
      if (Date.now() - lastLogin > LOGIN_RECORD_INTERVAL_MS) {
        void recordPlatformUserLogin(app.controlDb, user.id);
      }

      return { id: user.id, email: user.email, display_name: user.display_name, is_admin: true };
    } catch {
      return reply.code(401).send({ error: 'Invalid or expired token' });
    }
  });
}

export async function requireAdmin(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  // Dev escape hatch — mirrors the AUTH_ENABLED=false path in plugins/auth.ts.
  // When auth is globally disabled, treat DEV_ADMIN_USER_ID (or devOwnerId) as the admin.
  if (!config.auth.enabled) {
    const adminId = process.env.DEV_ADMIN_USER_ID || config.devOwnerId;
    return adminId;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing authorization' });
    return null;
  }

  try {
    const token = authHeader.substring(7);
    const claims = await authProvider.verifyJwt(token);

    // Look up user by cognito_sub and check is_admin
    const result = await app.controlDb.query(
      'SELECT id, is_admin FROM platform_users WHERE cognito_sub = $1',
      [claims.sub]
    );

    if (!result.rows[0]?.is_admin) {
      reply.code(403).send({ error: 'Not authorized as admin' });
      return null;
    }

    return result.rows[0].id;
  } catch {
    reply.code(401).send({ error: 'Invalid or expired token' });
    return null;
  }
}
