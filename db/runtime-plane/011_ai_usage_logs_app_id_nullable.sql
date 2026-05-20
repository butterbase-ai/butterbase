-- @scope: runtime
-- 011: Allow ai_usage_logs.app_id to be NULL for app-less gateway calls.
-- App-less calls go through /v1/chat/completions (no :appId path segment)
-- and identify the caller via platform_users.id only. We still want one row
-- per call in the usage log, so app_id becomes nullable.

BEGIN;

ALTER TABLE ai_usage_logs ALTER COLUMN app_id DROP NOT NULL;

COMMENT ON COLUMN ai_usage_logs.app_id IS
  'App that originated this call. NULL when the call came through the app-less gateway endpoint (/v1/chat/completions).';

COMMIT;
