-- @scope: runtime
-- Plan 11.5: NOT NULL cutover on the 13 runtime-plane tables Plan 11.1 added
--   organization_id to. Depends on Plan 11.2 runtime backfill --verify being
--   green AND Plan 11.4's mcp orphan cleanup having been run. If any row
--   still has NULL, the flip fails and the whole transaction rolls back.
-- No cross-plane FK is added — organization_id remains a logical reference
--   (same pattern as 034_apps_organization_id.sql).

BEGIN;

ALTER TABLE usage_meters
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE ai_usage_logs
  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE actor_usage_logs
  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE ai_video_jobs
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE storage_objects
  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE mcp_tool_call_log
  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE partner_proxy_logs
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE app_refresh_tokens
  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE app_verification_codes
  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE app_subscriptions
  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE app_orders
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE people_email_lookups
  ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE people_usage_logs
  ALTER COLUMN organization_id SET NOT NULL;

COMMIT;
