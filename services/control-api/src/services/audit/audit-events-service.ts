import type { Pool } from 'pg';
import type { AuditEventInput } from './types.js';

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
