-- @scope: data
-- Migration 007: Remove overly broad event-trigger service bypass policy
--
-- The event trigger from 004_rls_role_based.sql creates "butterbase_service_policy"
-- with roles={public} (ALL roles) and a GUC check (app.role = 'butterbase_service').
-- This is a security risk: any role that can set the app.role GUC variable (e.g. via
-- set_config() in a policy expression) can escalate to service-level access.
--
-- The explicit per-table "{table}_service_bypass" policies created by rls.ts are
-- properly scoped to the butterbase_service role and are the correct mechanism.

-- 1. Drop the event trigger (must happen before dropping the function)
DROP EVENT TRIGGER IF EXISTS butterbase_auto_service_policy_trigger;

-- 2. Drop the event trigger function
DROP FUNCTION IF EXISTS butterbase_auto_service_policy();

-- 3. Drop all butterbase_service_policy policies created by the event trigger
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename
    FROM pg_policies
    WHERE policyname = 'butterbase_service_policy'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS "butterbase_service_policy" ON %I.%I',
      pol.schemaname, pol.tablename
    );
    RAISE NOTICE 'Dropped butterbase_service_policy from %.%', pol.schemaname, pol.tablename;
  END LOOP;
END $$;

-- 4. Backfill: ensure every RLS-enabled table has an explicit service bypass policy
--    scoped to the butterbase_service role. This covers any tables that only had
--    the event-trigger policy and would otherwise lose service access.
DO $$
DECLARE
  tbl record;
BEGIN
  FOR tbl IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND rowsecurity = true
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = tbl.schemaname
        AND tablename = tbl.tablename
        AND policyname = tbl.tablename || '_service_bypass'
    ) THEN
      EXECUTE format(
        'CREATE POLICY "%s_service_bypass" ON %I.%I TO butterbase_service USING (true) WITH CHECK (true)',
        tbl.tablename, tbl.schemaname, tbl.tablename
      );
      RAISE NOTICE 'Backfilled %_service_bypass on %.%', tbl.tablename, tbl.schemaname, tbl.tablename;
    END IF;
  END LOOP;
END $$;
