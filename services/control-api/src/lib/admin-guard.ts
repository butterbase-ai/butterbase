// Centralized admin authorization for /admin/* routes.
// Returns the platform_user row when the caller has a valid JWT AND holds the
// 'admin' role in platform_user_roles. Returns null AND sends an appropriate
// 401/403 response when not authorized.
//
// is_admin is computed via EXISTS against the role join rather than read off
// platform_users directly — the column is left in place for now (dropped in
// a follow-up once nothing reads it) but this guard no longer trusts it.

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
    `SELECT pu.id, pu.email, pu.display_name,
            EXISTS (
              SELECT 1 FROM platform_user_roles pur
              JOIN platform_roles pr ON pr.id = pur.role_id
              WHERE pur.platform_user_id = pu.id AND pr.name = 'admin'
            ) AS is_admin
     FROM platform_users pu
     WHERE pu.cognito_sub = $1`,
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
