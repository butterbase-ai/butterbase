-- @scope: platform
-- F-05: plan-tiered audit retention + immutability guard for audit_events
--
-- 1. Add audit_retention_days to plans; seed enterprise at 365, default 180.
-- 2. Create purge_audit_events() SECURITY DEFINER — the authorised path to
--    delete audit rows (SOC 2 CC6.1).
-- 3. Immutability trigger: any direct UPDATE/DELETE on audit_events raises an
--    error unless the session has set audit.purge_active = 'true'.
--    purge_audit_events() sets this flag (transaction-local) before deleting.
--    The REVOKE below additionally blocks non-owner roles from direct writes.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS audit_retention_days INT NOT NULL DEFAULT 180;

UPDATE plans SET audit_retention_days = 365 WHERE id = 'enterprise';

COMMENT ON COLUMN plans.audit_retention_days IS
  'How many days of audit_events to keep for orgs on this plan. Default 180; enterprise minimum 365.';

-- Trigger function: block direct UPDATE/DELETE unless the purge flag is set.
-- purge_audit_events() is the only caller that sets audit.purge_active = 'true'.
CREATE OR REPLACE FUNCTION audit_events_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = public
AS $$
BEGIN
  IF current_setting('audit.purge_active', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'direct UPDATE/DELETE on audit_events is not permitted; use purge_audit_events()';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER audit_events_immutability_guard
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_guard();

-- purge_audit_events()
-- Deletes audit events older than the owning org's plan retention window.
-- Rows with no organization_id (pre-backfill / deleted-app orphans) fall back
-- to the 180-day floor. Returns the number of rows deleted.
CREATE OR REPLACE FUNCTION purge_audit_events()
  RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  -- Set the transaction-local flag checked by the immutability trigger.
  PERFORM set_config('audit.purge_active', 'true', true);
  WITH deleted AS (
    DELETE FROM audit_events ae
    WHERE ae.created_at < COALESCE(
      (
        SELECT now() - (p.audit_retention_days || ' days')::interval
          FROM organizations o
          JOIN plans p ON p.id = COALESCE(o.plan_id, 'free')
         WHERE o.id = ae.organization_id
      ),
      now() - interval '180 days'
    )
    RETURNING id
  )
  SELECT count(*)::bigint INTO deleted_count FROM deleted;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION purge_audit_events() IS
  'Plan-tiered audit log retention purge. Owned by schema owner; run nightly via the billing cron.';

-- Belt-and-suspenders: also revoke direct writes from non-owner roles.
-- The trigger above is the primary guard for the connection role (which owns the table).
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;
