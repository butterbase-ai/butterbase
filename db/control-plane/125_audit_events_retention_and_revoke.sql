-- @scope: platform
-- F-05: plan-tiered audit retention + revoke app-role write access
--
-- 1. Add audit_retention_days to plans; seed enterprise at 365, default 180.
-- 2. Create purge_audit_events() SECURITY DEFINER so the nightly job no longer
--    needs a direct DELETE — the function is owned by the schema owner, giving
--    auditors a single, inspectable purge path (SOC 2 CC6.1).
-- 3. Revoke UPDATE/DELETE on audit_events from PUBLIC so the application role
--    cannot mutate the audit trail directly.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS audit_retention_days INT NOT NULL DEFAULT 180;

UPDATE plans SET audit_retention_days = 365 WHERE id = 'enterprise';

COMMENT ON COLUMN plans.audit_retention_days IS
  'How many days of audit_events to keep for orgs on this plan. Default 180; enterprise minimum 365.';

-- purge_audit_events()
-- Deletes audit events older than the owning org's plan retention window.
-- Rows with no organization_id (pre-backfill / deleted-app orphans) fall back
-- to the 180-day floor. Returns the number of rows deleted.
-- SECURITY DEFINER: runs as the function owner regardless of caller role, so
-- UPDATE/DELETE can be safely revoked from the application role below.
CREATE OR REPLACE FUNCTION purge_audit_events()
  RETURNS bigint
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
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
  SELECT count(*)::bigint FROM deleted;
$$;

COMMENT ON FUNCTION purge_audit_events() IS
  'Plan-tiered audit log retention purge. Owned by schema owner; run nightly via the billing cron.';

-- Revoke direct write access from the application role.
-- The nightly cron calls purge_audit_events() instead of a raw DELETE.
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;
