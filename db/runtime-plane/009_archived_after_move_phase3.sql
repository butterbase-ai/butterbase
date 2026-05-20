-- @scope: runtime
-- Phase 3: archived_after_move tag for runtime tables introduced after 006
-- (app_deployments, usage_meters). These were added to MOVE_APP_RUNTIME_TABLES
-- but the column was never added, so copying_runtime failed with
-- 'column "archived_after_move" does not exist' on every move.
-- Idempotent (ADD COLUMN IF NOT EXISTS).

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'app_deployments',
    'usage_meters'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS archived_after_move UUID', t);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (archived_after_move) WHERE archived_after_move IS NOT NULL',
        t || '_archived_idx', t);
    END IF;
  END LOOP;
END $$;
