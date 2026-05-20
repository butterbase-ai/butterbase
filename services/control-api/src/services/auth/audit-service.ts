import type { Pool } from 'pg';
import { logAuditEvent as logAuditEventV2 } from '../audit/audit-events-service.js';
import type { LegacyAuthEventType } from '../audit/types.js';

/**
 * @deprecated Use `logAuditEvent` from `services/audit/audit-events-service.ts`.
 * This shim routes legacy auth callers to the new `audit_events` table while
 * preserving the original signature.
 */
export type AuditEventType = LegacyAuthEventType;

export interface AuditLogData {
  appId: string;
  userId?: string;
  eventType: AuditEventType;
  eventData?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  success: boolean;
  errorMessage?: string;
}

/**
 * @deprecated Prefer `logAuditEvent` from `services/audit/audit-events-service.ts`,
 * or the `withAudit` / `logFromRequest` helpers in `services/audit/with-audit.ts`.
 *
 * Legacy callers (pre-migration-034) continue to work: the data is mapped to
 * the new `audit_events` table with `category='auth'` and
 * `actor_type='app_user'` (since all legacy callers are app-user auth flows).
 */
export async function logAuditEvent(
  db: Pool,
  data: AuditLogData
): Promise<void> {
  await logAuditEventV2(db, {
    appId: data.appId,
    category: 'auth',
    eventType: data.eventType,
    resourceType: 'app_user',
    resourceId: data.userId,
    actorType: data.userId ? 'app_user' : 'anonymous',
    actorId: data.userId ?? null,
    eventData: data.eventData,
    ipAddress: data.ipAddress ?? null,
    userAgent: data.userAgent ?? null,
    success: data.success,
    errorMessage: data.errorMessage ?? null,
  });
}
