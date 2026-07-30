import type { Pool } from 'pg';
import type { AuditEventInput } from './types.js';
import { recordPlatformUserAction, recordAppUserAction } from '../activity-service.js';
import { getRuntimeDbForApp } from '../region-resolver.js';

/**
 * Insert a clone lifecycle event into auth_audit_logs, scoped to the SOURCE
 * app so that source owners can see who cloned and when.
 *
 * Written to the control-plane DB (where auth_audit_logs lives).
 * Returns a promise that resolves on success; callers in the clone worker
 * should .catch() secondary failures so they don't compound the original error.
 */
export async function insertCloneAuditLog(
  controlDb: Pool,
  opts: {
    appId: string;
    userId: string | null;
    eventType: 'template_clone_started' | 'template_clone_completed' | 'template_clone_failed';
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await controlDb.query(
    `INSERT INTO auth_audit_logs (app_id, user_id, event_type, event_data, success, error_message)
     VALUES ($1, $2::uuid, $3, $4::jsonb, $5, $6)`,
    [
      opts.appId,
      opts.userId ?? null,
      opts.eventType,
      JSON.stringify(opts.metadata),
      opts.eventType !== 'template_clone_failed',
      opts.eventType === 'template_clone_failed' ? (opts.metadata.error as string | undefined) ?? null : null,
    ],
  );
}

/**
 * Insert a single audit event. Fire-and-forget safe: failures are logged
 * but never thrown, so a broken audit pipeline cannot fail a user request.
 *
 * `db` receives the audit_events insert (both planes have this table since
 * migration 034 / runtime-plane 001, so either is valid).
 *
 * Activity aggregates live on different planes: platform_users lives on
 * control, app_users on runtime (moved there in runtime-plane migration
 * 061). When the caller is on controlDb and the event has actor_type
 * app_user, pass `opts.controlDb` — we resolve the app's home-region
 * runtime pool via getRuntimeDbForApp so the app_user activity bump
 * writes to a plane where app_users actually exists. If `opts.controlDb`
 * is absent we fall back to `db` — correct when `db` already IS the
 * runtime pool (auth/*.ts callers).
 */
/**
 * Convenience wrapper for callers on the control-plane that want app-user
 * activity aggregates written to the correct runtime pool automatically.
 * Prefer this over calling logAuditEvent(controlDb, event) directly — the
 * bare form skips the runtime-pool resolution and drops app_user activity
 * records with "relation app_users does not exist" (runtime-plane migration
 * 061 moved app_users off control).
 */
export function logAuditEventFromControlDb(
  controlDb: Pool,
  event: AuditEventInput,
): Promise<void> {
  return logAuditEvent(controlDb, event, { controlDb });
}

export async function logAuditEvent(
  db: Pool,
  event: AuditEventInput,
  opts?: { controlDb?: Pool },
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_events (
         app_id, category, event_type, action,
         resource_type, resource_id,
         actor_type, actor_id,
         event_data, ip_address, user_agent,
         success, error_message, correlation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        event.appId,
        event.category,
        event.eventType,
        event.action ?? null,
        event.resourceType ?? null,
        event.resourceId ?? null,
        event.actorType,
        event.actorId ?? null,
        event.eventData ?? {},
        event.ipAddress ?? null,
        event.userAgent ?? null,
        event.success,
        event.errorMessage ?? null,
        event.correlationId ?? null,
      ]
    );
    // Post-insert: bump activity aggregates per actor type.
    if (event.actorType === 'platform_user' && event.actorId) {
      // platform_users always lives on control-plane. If db IS control,
      // this works directly; if the caller passed runtime, opts.controlDb
      // is the correct plane. Fall back to db when neither hint is set.
      void recordPlatformUserAction(opts?.controlDb ?? db, event.actorId);
    } else if (event.actorType === 'app_user' && event.actorId) {
      const actorId = event.actorId;
      const appId = event.appId;
      if (opts?.controlDb) {
        void (async () => {
          try {
            const runtimePool = await getRuntimeDbForApp(opts.controlDb!, appId);
            await recordAppUserAction(runtimePool, actorId);
          } catch (err) {
            console.error('[AUDIT] Failed to resolve runtime pool for app-user activity bump on %s:', appId, err);
          }
        })();
      } else {
        void recordAppUserAction(db, actorId);
      }
    }
  } catch (error) {
    console.error('[AUDIT] Failed to log event:', error);
  }
}
