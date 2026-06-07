-- @scope: runtime
-- Finish the function_triggers cutover that was set up in
-- 001_initial_runtime_schema.  The function_triggers table has been an empty
-- defensive container; app_functions.trigger_type / trigger_config have stayed
-- the source of truth in every reader until this migration.
--
-- This migration:
--   1. Backfills function_triggers from app_functions for every non-deleted
--      function that has a trigger_type set.
--   2. Drops the legacy app_functions.trigger_type and trigger_config columns.
--
-- The backfill is idempotent (ON CONFLICT (function_id, trigger_type) DO
-- NOTHING relies on idx_function_triggers_unique_type from the initial
-- schema).  The DROPs are one-shot but guarded with IF EXISTS so a re-run on
-- a DB where the columns were already removed out-of-band is safe.
--
-- Run AFTER deploying the matching control-api + deno-runtime build that
-- reads triggers from function_triggers.

INSERT INTO function_triggers (function_id, app_id, trigger_type, trigger_config, enabled)
SELECT id, app_id, trigger_type, COALESCE(trigger_config, '{}'::jsonb), true
  FROM app_functions
 WHERE trigger_type IS NOT NULL
   AND deleted_at IS NULL
ON CONFLICT (function_id, trigger_type) DO NOTHING;

ALTER TABLE app_functions DROP COLUMN IF EXISTS trigger_type;
ALTER TABLE app_functions DROP COLUMN IF EXISTS trigger_config;
