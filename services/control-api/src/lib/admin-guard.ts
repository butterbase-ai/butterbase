// Centralized admin authorization for /admin/* routes.
// Returns the platform_user row when the caller has a valid JWT AND is_admin = true.
// Returns null AND sends an appropriate 401/403 response when not authorized.

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { AuthProvider } from '../services/auth-provider.js';

export interface AdminUser {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  controlDb: Pool,
  authProvider: AuthProvider,
): Promise<AdminUser | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'missing_authorization' });
    return null;
  }
  let claims: { sub: string };
  try {
    claims = await authProvider.verifyJwt(authHeader.substring(7));
  } catch {
    reply.code(401).send({ error: 'invalid_token' });
    return null;
  }
  const r = await controlDb.query<AdminUser>(
    'SELECT id, email, display_name, is_admin FROM platform_users WHERE cognito_sub = $1',
    [claims.sub],
  );
  const user = r.rows[0];
  if (!user) {
    reply.code(403).send({ error: 'unknown_user' });
    return null;
  }
  if (!user.is_admin) {
    reply.code(403).send({ error: 'not_admin' });
    return null;
  }
  return user;
}
