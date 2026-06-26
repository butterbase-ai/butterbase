-- @scope: runtime
-- 028: Add user_id column to ai_usage_logs so app-less gateway calls
-- (app_id IS NULL, since migration 011) and calls against apps the caller
-- does not own can still be aggregated per user.
--
-- Pre-028, the only path from a usage row back to a billed user was
-- ai_usage_logs.app_id → apps.owner_id. App-less calls and non-owned-app
-- calls were silently dropped from usage_meters and the admin dashboard,
-- even though credit_leases (keyed on user_id directly) charged them
-- correctly. We backfill from request_metadata->>'user_id', which the
-- writers have populated all along.

BEGIN;

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS user_id uuid;

UPDATE ai_usage_logs
   SET user_id = (request_metadata->>'user_id')::uuid
 WHERE user_id IS NULL
   AND request_metadata ? 'user_id'
   AND request_metadata->>'user_id' IS NOT NULL
   AND request_metadata->>'user_id' <> '';

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_created
  ON ai_usage_logs (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

COMMENT ON COLUMN ai_usage_logs.user_id IS
  'Platform user the call is attributed to. Populated for every call (app-bound or app-less). Use this — not apps.owner_id — to aggregate usage per user.';

COMMIT;
