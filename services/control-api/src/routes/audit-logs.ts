import type { FastifyInstance } from 'fastify';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';
import { createAgentError, getDocUrl, isHttpError } from '../services/error-handler.js';
import { RESOURCE_NOT_FOUND, EXTERNAL_DB_ERROR } from '@butterbase/shared/error-types';
import { requireUserId } from '../utils/require-auth.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';

/**
 * Returns audit events for an app. Reads from the current `audit_events` table
 * and unions in legacy `auth_audit_logs` rows (normalized to the new shape)
 * so historical activity is visible after migration 034.
 *
 * Supported filters (all optional):
 *   category       'auth' | 'admin' | 'function'
 *   event_type     exact match
 *   action         'create' | 'update' | 'delete' | 'invoke' | 'enable' | 'disable'
 *   resource_type  see migration 034
 *   resource_id    exact match
 *   actor_id       exact match (platform user id / app user id / api key id)
 *   from           ISO-8601 timestamp, inclusive lower bound on created_at
 *   to             ISO-8601 timestamp, exclusive upper bound on created_at
 *   limit          default 100, max 500
 *   offset         default 0
 */
export async function auditLogRoutes(app: FastifyInstance) {
  app.get('/v1/:app_id/audit-logs', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const q = request.query as Record<string, string | undefined>;

    const rawLimit = q.limit ? parseInt(q.limit, 10) : 100;
    const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 100 : rawLimit), 500);
    const rawOffset = q.offset ? parseInt(q.offset, 10) : 0;
    const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

    const filters = {
      category: q.category,
      event_type: q.event_type,
      action: q.action,
      resource_type: q.resource_type,
      resource_id: q.resource_id,
      actor_id: q.actor_id ?? q.user_id, // accept legacy `user_id` param
      from: q.from,
      to: q.to,
    };

    try {
      await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request));

      // Build the unified view: audit_events UNION legacy auth_audit_logs
      // (legacy rows get category='auth' and actor fields derived from user_id)
      const params: any[] = [app_id];
      let pi = 2;

      const eventsWhere: string[] = ['app_id = $1'];
      const legacyWhere: string[] = ['app_id = $1'];

      // category: only event_events has it; legacy is always 'auth'
      if (filters.category) {
        params.push(filters.category);
        eventsWhere.push(`category = $${pi}`);
        // Legacy is 'auth' — exclude if category is not 'auth'
        legacyWhere.push(filters.category === 'auth' ? `TRUE` : `FALSE`);
        pi++;
      }

      if (filters.event_type) {
        params.push(filters.event_type);
        eventsWhere.push(`event_type = $${pi}`);
        legacyWhere.push(`event_type = $${pi}`);
        pi++;
      }

      if (filters.action) {
        params.push(filters.action);
        eventsWhere.push(`action = $${pi}`);
        // Legacy has no action column — exclude when filtering
        legacyWhere.push(`FALSE`);
        pi++;
      }

      if (filters.resource_type) {
        params.push(filters.resource_type);
        eventsWhere.push(`resource_type = $${pi}`);
        legacyWhere.push(filters.resource_type === 'app_user' ? `TRUE` : `FALSE`);
        pi++;
      }

      if (filters.resource_id) {
        params.push(filters.resource_id);
        eventsWhere.push(`resource_id = $${pi}`);
        legacyWhere.push(`user_id::text = $${pi}`);
        pi++;
      }

      if (filters.actor_id) {
        params.push(filters.actor_id);
        eventsWhere.push(`actor_id = $${pi}`);
        legacyWhere.push(`user_id::text = $${pi}`);
        pi++;
      }

      if (filters.from) {
        params.push(filters.from);
        eventsWhere.push(`created_at >= $${pi}`);
        legacyWhere.push(`created_at >= $${pi}`);
        pi++;
      }

      if (filters.to) {
        params.push(filters.to);
        eventsWhere.push(`created_at < $${pi}`);
        legacyWhere.push(`created_at < $${pi}`);
        pi++;
      }

      // Platform-side: legacy auth_audit_logs + any audit_events still written
      // via controlDb (e.g. rag.ts, auto-api.ts). Pre-cutover events also
      // remain here until migration 061.
      const platformSql = `
        SELECT
          id, app_id, category, event_type, action,
          resource_type, resource_id,
          actor_type, actor_id,
          event_data, ip_address, user_agent,
          success, error_message, correlation_id, created_at
        FROM audit_events
        WHERE ${eventsWhere.join(' AND ')}
        UNION ALL
        SELECT
          id, app_id,
          'auth'::text AS category,
          event_type,
          NULL::text AS action,
          'app_user'::text AS resource_type,
          user_id::text AS resource_id,
          CASE WHEN user_id IS NULL THEN 'anonymous' ELSE 'app_user' END AS actor_type,
          user_id::text AS actor_id,
          COALESCE(event_data, '{}'::jsonb) AS event_data,
          ip_address, user_agent,
          success, error_message,
          NULL::uuid AS correlation_id,
          created_at
        FROM auth_audit_logs
        WHERE ${legacyWhere.join(' AND ')}
      `;

      // Runtime-side: audit_events for app_user / api_key actors written by
      // post-cutover auth handlers (logAuditEvent(app.runtimeDb(region), ...)).
      const runtimeSql = `
        SELECT
          id, app_id, category, event_type, action,
          resource_type, resource_id,
          actor_type, actor_id,
          event_data, ip_address, user_agent,
          success, error_message, correlation_id, created_at
        FROM audit_events
        WHERE ${eventsWhere.join(' AND ')}
      `;

      // Fetch (limit+offset) rows from each tier, merge in JS, then slice.
      // Approximate for very large offsets; fine for typical dashboard pagination.
      const fetchCap = Math.min(limit + offset, 1000);
      const fetchSql = (body: string) => `${body} ORDER BY created_at DESC LIMIT ${fetchCap}`;
      // Read runtime-side audit_events from the app's home region (auth +
      // function events written by the post-cutover handlers live there).
      const runtimePool = await getRuntimeDbForApp(app.controlDb, app_id);

      const countParams = params.slice();

      const [platformData, platformCount, runtimeData, runtimeCount] = await Promise.all([
        app.controlDb.query(fetchSql(platformSql), params),
        app.controlDb.query(`SELECT COUNT(*)::int AS total FROM (${platformSql}) p`, countParams),
        runtimePool.query(fetchSql(runtimeSql), params),
        runtimePool.query(`SELECT COUNT(*)::int AS total FROM (${runtimeSql}) r`, countParams),
      ]);

      // Merge + sort desc; runtime rows that have already been migrated will
      // dedupe by id (uuid → set-based dedupe).
      const seen = new Set<string>();
      const merged = [...platformData.rows, ...runtimeData.rows]
        .filter((r) => {
          const key = String(r.id);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      const total: number =
        (platformCount.rows[0]?.total ?? 0) + (runtimeCount.rows[0]?.total ?? 0);
      const page = merged.slice(offset, offset + limit);
      const nextOffset = offset + page.length < total ? offset + page.length : null;

      return reply.send({
        logs: page,
        total,
        limit,
        offset,
        nextOffset,
      });
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'App not found',
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND)
        }));
      }
      app.log.error({ error }, 'Failed to fetch audit logs');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to fetch audit logs',
        remediation: 'Retry the operation. If the problem persists, check database connectivity or contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR)
      }));
    }
  });
}
