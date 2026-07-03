import type { Pool } from 'pg';
import { NotFoundError } from './api-errors.js';

/**
 * Resolve an app's owning organization id from the runtime plane.
 *
 * Plan 11.2 backfilled every apps row's organization_id from the Plan 04
 * user_app_index / owner mapping. Plan 11.5 will flip apps.organization_id
 * NOT NULL. A null return here means Plan 11.2 hasn't run OR data is
 * corrupt — fail loudly, do NOT paper over.
 *
 * Ship as the single lookup for every INSERT into app-attributed runtime
 * tables (Plan 11.3): ai_usage_logs, actor_usage_logs, ai_video_jobs,
 * storage_objects, mcp_tool_call_log, partner_proxy_logs, app_refresh_tokens,
 * app_verification_codes, app_subscriptions, app_orders,
 * people_email_lookups, people_usage_logs.
 */
export async function resolveOrgFromApp(runtimePool: Pool, appId: string): Promise<string> {
  const result = await runtimePool.query<{ organization_id: string | null }>(
    'SELECT organization_id FROM apps WHERE id = $1',
    [appId],
  );
  if (result.rows.length === 0) {
    throw new NotFoundError('app', appId);
  }
  const orgId = result.rows[0].organization_id;
  if (!orgId) {
    throw new Error(`resolveOrgFromApp: app ${appId} has no organization_id`);
  }
  return orgId;
}
