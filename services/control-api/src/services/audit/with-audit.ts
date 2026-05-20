import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '@butterbase/shared/types';
import { logAuditEvent } from './audit-events-service.js';
import type {
  AuditAction,
  AuditActorType,
  AuditCategory,
  AuditEventInput,
  AuditResourceType,
} from './types.js';

export interface WithAuditMeta {
  appId: string;
  category: AuditCategory;
  eventType: string;
  action?: AuditAction;
  resourceType?: AuditResourceType;
  resourceId?: string;
  eventData?: Record<string, unknown>;
}

export function deriveActor(auth: AuthContext | undefined): {
  actorType: AuditActorType;
  actorId: string | null;
} {
  if (!auth) return { actorType: 'anonymous', actorId: null };
  switch (auth.authMethod) {
    case 'jwt':
      return { actorType: 'platform_user', actorId: auth.userId };
    case 'end_user_jwt':
      return { actorType: 'app_user', actorId: auth.userId };
    case 'api_key':
      return { actorType: 'api_key', actorId: auth.keyId ?? auth.userId };
    case 'anonymous':
    default:
      return { actorType: 'anonymous', actorId: null };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contextFromRequest(request: FastifyRequest) {
  const actor = deriveActor(request.auth);
  const rawId = request.id as string | undefined;
  const correlationId = rawId && UUID_RE.test(rawId) ? rawId : null;
  return {
    ip: request.ip ?? null,
    ua: (request.headers['user-agent'] as string | undefined) ?? null,
    correlationId,
    ...actor,
  };
}

/**
 * Wrap a route handler body: logs success/failure audit event automatically.
 * The returned value is passed through; exceptions re-thrown after logging.
 *
 * For routes where the success payload needs to feed event_data (e.g. newly
 * created resource id), prefer calling logAuditEvent directly.
 */
export async function withAudit<T>(
  request: FastifyRequest,
  meta: WithAuditMeta,
  fn: () => Promise<T>
): Promise<T> {
  const ctx = contextFromRequest(request);
  try {
    const result = await fn();
    void logAuditEvent(request.server.controlDb, {
      appId: meta.appId,
      category: meta.category,
      eventType: meta.eventType,
      action: meta.action,
      resourceType: meta.resourceType,
      resourceId: meta.resourceId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      eventData: meta.eventData,
      ipAddress: ctx.ip,
      userAgent: ctx.ua,
      success: true,
      correlationId: ctx.correlationId,
    } satisfies AuditEventInput);
    return result;
  } catch (err) {
    void logAuditEvent(request.server.controlDb, {
      appId: meta.appId,
      category: meta.category,
      eventType: meta.eventType,
      action: meta.action,
      resourceType: meta.resourceType,
      resourceId: meta.resourceId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      eventData: meta.eventData,
      ipAddress: ctx.ip,
      userAgent: ctx.ua,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      correlationId: ctx.correlationId,
    } satisfies AuditEventInput);
    throw err;
  }
}

/**
 * Convenience: log a one-off event with the actor/ip/ua derived from request.
 * Use for cases where you don't want to wrap the whole handler (e.g. auth
 * routes that branch into multiple success/failure paths).
 */
export function logFromRequest(
  request: FastifyRequest,
  event: Omit<AuditEventInput, 'actorType' | 'actorId' | 'ipAddress' | 'userAgent' | 'correlationId'>
): void {
  const ctx = contextFromRequest(request);
  void logAuditEvent(request.server.controlDb, {
    ...event,
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    ipAddress: ctx.ip,
    userAgent: ctx.ua,
    correlationId: ctx.correlationId,
  });
}
