-- @scope: data
-- Migration 009: Fix realtime trigger permissions
--
-- The per-table trigger functions created by realtime.enable_table_trigger()
-- were missing SECURITY DEFINER, causing "permission denied for table changes"
-- when non-owner roles (butterbase_service, butterbase_user) wrote to
-- realtime-enabled tables. The trigger tried to INSERT into realtime.changes
-- but only SELECT was granted.

-- ============================================================================
-- 1. Grant INSERT on realtime.changes
-- ============================================================================

GRANT SELECT, INSERT ON realtime.changes TO butterbase_service, butterbase_user;

-- ============================================================================
-- 2. Patch existing per-table trigger functions to add SECURITY DEFINER
-- ============================================================================

DO $$
DECLARE
  t RECORD;
  fn_name TEXT;
BEGIN
  FOR t IN SELECT table_name FROM realtime.watched_tables LOOP
    fn_name := 'notify_' || replace(t.table_name, '.', '_');
    EXECUTE format('ALTER FUNCTION realtime.%I() SECURITY DEFINER', fn_name);
  END LOOP;
END;
$$;
