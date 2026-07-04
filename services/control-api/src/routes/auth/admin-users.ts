// Admin endpoints for managing app_users (list, delete).
// Scoped to app owners — rejects end-user JWTs and anonymous callers.
import type { FastifyInstance } from 'fastify';
import { AppResolver, AppNotFoundError } from '../../services/app-resolver.js';
import { createAgentError, getDocUrl } from '../../services/error-handler.js';
import { RESOURCE_NOT_FOUND } from '@butterbase/shared/error-types';
import { logFromRequest } from '../../services/audit/with-audit.js';
import { config } from '../../config.js';
import { resolveAppHomeRegion } from '../../services/region-resolver.js';
import { getRuntimeDbPool } from '../../services/runtime-db.js';

interface CursorShape {
  c: string; // created_at ISO
  i: string; // id
}

function encodeCursor(c: CursorShape): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(s: string): CursorShape | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (typeof parsed?.c === 'string' && typeof parsed?.i === 'string') return parsed;
  } catch { /* fall through */ }
  return null;
}

function requireOwnerAuth(request: any, reply: any): boolean {
  if (request.auth.authMethod === 'end_user_jwt' || request.auth.authMethod === 'anonymous') {
    reply.code(403).send(createAgentError({
      code: 'AUTH_INSUFFICIENT_PERMISSIONS',
      message: 'Only app owners can manage auth users. Use an API key or platform JWT.',
      remediation: 'Authenticate with your Butterbase API key (bb_sk_...) instead of an end-user JWT.',
      documentation_url: getDocUrl('AUTH_INSUFFICIENT_PERMISSIONS'),
    }));
    return false;
  }
  return true;
}

export async function adminAuthUsersRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /v1/:app_id/admin/auth/users?limit=&cursor=
  // -------------------------------------------------------------------------
  app.get('/v1/:app_id/admin/auth/users', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const { limit: rawLimit, cursor } = request.query as { limit?: string; cursor?: string };

    if (!requireOwnerAuth(request, reply)) return;

    try {
      const region = await resolveAppHomeRegion(app.controlDb, app_id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      await AppResolver.resolveApp(app.controlDb, app_id, request.auth.userId!, request.auth?.organizationId ?? null);

      const limit = Math.min(Math.max(parseInt(rawLimit ?? '50', 10) || 50, 1), 200);

      const params: unknown[] = [app_id];
      let where = 'WHERE app_id = $1';
      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (!decoded) {
          return reply.code(400).send(createAgentError({
            code: 'VALIDATION_INVALID_TYPE',
            message: 'Invalid cursor.',
            remediation: 'Pass the cursor exactly as returned in the previous response, or omit to start from the beginning.',
            documentation_url: getDocUrl('VALIDATION_INVALID_TYPE'),
          }));
        }
        params.push(decoded.c, decoded.i);
        where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }
      params.push(limit + 1);

      const result = await runtimeDb.query<{
        id: string;
        email: string;
        provider: string | null;
        provider_uid: string | null;
        email_verified: boolean;
        last_sign_in_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id, email, provider, provider_uid, email_verified, last_sign_in_at, created_at
           FROM app_users
           ${where}
           ORDER BY created_at DESC, id DESC
           LIMIT $${params.length}`,
        params,
      );

      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
      const nextCursor = hasMore && rows.length > 0
        ? encodeCursor({ c: rows[rows.length - 1].created_at.toISOString(), i: rows[rows.length - 1].id })
        : null;

      return { users: rows, next_cursor: nextCursor };
    } catch (err) {
      if (err instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
        }));
      }
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/:app_id/admin/auth/users/:user_id
  // -------------------------------------------------------------------------
  app.delete('/v1/:app_id/admin/auth/users/:user_id', async (request, reply) => {
    const { app_id, user_id } = request.params as { app_id: string; user_id: string };

    if (!requireOwnerAuth(request, reply)) return;

    try {
      const region = await resolveAppHomeRegion(app.controlDb, app_id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      await AppResolver.resolveApp(app.controlDb, app_id, request.auth.userId!, request.auth?.organizationId ?? null);

      const result = await runtimeDb.query<{ email: string }>(
        `DELETE FROM app_users WHERE app_id = $1 AND id = $2 RETURNING email`,
        [app_id, user_id],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'User not found in this app.',
          remediation: 'Use GET /v1/:app_id/admin/auth/users to list user IDs.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
        }));
      }

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'auth.user.delete',
        action: 'delete',
        resourceType: 'app_user',
        resourceId: user_id,
        eventData: { email: result.rows[0].email },
        success: true,
      });

      app.platformEventBus.emit('auth.user.deleted', {
        appId: app_id,
        userId: user_id,
        email: result.rows[0].email,
        runtimeDb,
      });

      return { deleted: true, user_id, email: result.rows[0].email };
    } catch (err) {
      if (err instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
        }));
      }
      throw err;
    }
  });
}
