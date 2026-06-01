import type { Pool } from 'pg';
import type { AuditEventInput } from './types.js';

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
 */
export async function logAuditEvent(
  db: Pool,
  event: AuditEventInput
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
  } catch (error) {
    console.error('[AUDIT] Failed to log event:', error);
  }
}
