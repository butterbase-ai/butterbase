import type { Pool } from 'pg';
import { sendBillingEmail } from './auth/email-service.js';
import { createActionToken } from './notification-prefs.service.js';

export interface IdlePauseApp { id: string; name: string; organization_id: string }
type Log = { warn(obj: unknown, msg?: string): void };

export async function sendIdlePauseEmail(
  controlDb: Pool,
  app: IdlePauseApp,
  template: 'project_idle_warning' | 'project_idle_reminder' | 'project_paused_idle',
  warnDays: number,
  log: Log,
  inactiveDays?: number,
): Promise<void> {
  try {
    const owners = await controlDb.query<{ id: string; email: string }>(
      `SELECT DISTINCT pu.id, pu.email FROM organization_members om
         JOIN platform_users pu ON pu.id = om.user_id
        WHERE om.organization_id = $1 AND om.role = 'owner' AND pu.email IS NOT NULL`,
      [app.organization_id],
    );
    for (const owner of owners.rows) {
      try {
        let unsubscribeTemplate: string | undefined;
        try {
          unsubscribeTemplate = await createActionToken(controlDb, {
            userId: owner.id, action: 'unsubscribe_template', payload: { template },
          });
        } catch (err) {
          log.warn({ err, appId: app.id, userId: owner.id }, '[idle-pause] unsubscribe token unavailable');
        }
        const result = await sendBillingEmail(owner.email, template, {
          appId: app.id, appName: app.name, organizationId: app.organization_id, warnDays: String(warnDays),
          ...(inactiveDays !== undefined ? { inactiveDays: String(inactiveDays) } : {}),
        }, {
          controlPool: controlDb, userId: owner.id, scope: { appId: app.id },
          actionTokens: unsubscribeTemplate ? { unsubscribeTemplate } : undefined,
        });
        if (result === 'failed') log.warn({ appId: app.id, userId: owner.id, template }, '[idle-pause] email delivery failed');
      } catch (err) {
        log.warn({ err, appId: app.id, userId: owner.id, template }, '[idle-pause] email delivery failed');
      }
    }
  } catch (err) {
    log.warn({ err, appId: app.id, template }, '[idle-pause] owner email lookup failed');
  }
}

export async function sendIdlePauseBreakerEmail(count: number, freeApps: number, log: Log): Promise<void> {
  if (!process.env.OPS_ALERT_EMAIL) return;
  try {
    const result = await sendBillingEmail(process.env.OPS_ALERT_EMAIL, 'idle_pause_breaker_ops', {
      count: String(count), freeApps: String(freeApps),
    });
    if (result === 'failed') log.warn({ count, freeApps }, '[idle-pause] ops email delivery failed');
  } catch (err) {
    log.warn({ err }, '[idle-pause] ops email delivery failed');
  }
}
