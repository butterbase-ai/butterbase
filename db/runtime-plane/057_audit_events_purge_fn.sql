-- @scope: runtime
-- F-05: plan-tiered audit retention on the runtime plane + immutability guard.
--
-- The runtime plane has no direct access to control-plane organizations/plans,
-- so the enterprise org set is passed in as a parameter by the nightly cron
-- (queried from the control plane before dispatching to each region).
--
-- purge_audit_events(enterprise_org_ids uuid[])
--   enterprise_org_ids  IDs of organizations on plans with audit_retention_days > 180.
--                       Defaults to empty array (all rows use the 180-day floor).
-- Returns the number of rows deleted.
--
-- Immutability trigger: any direct UPDATE/DELETE on audit_events raises an
-- error unless the session has set audit.purge_active = 'true'.
-- purge_audit_events() sets this flag (transaction-local) before deleting.
-- The REVOKE below additionally blocks non-owner roles from direct writes.

-- Trigger function: block direct UPDATE/DELETE unless the purge flag is set.
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

CREATE OR REPLACE FUNCTION purge_audit_events(enterprise_org_ids uuid[] DEFAULT '{}')
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
    DELETE FROM audit_events
    WHERE created_at < CASE
      WHEN organization_id = ANY(enterprise_org_ids) THEN now() - interval '365 days'
      ELSE now() - interval '180 days'
    END
    RETURNING id
  )
  SELECT count(*)::bigint INTO deleted_count FROM deleted;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION purge_audit_events(uuid[]) IS
  'Plan-tiered audit log retention purge. Enterprise orgs keep 12 months; all others 180 days.';

-- Belt-and-suspenders: also revoke direct writes from non-owner roles.
-- The trigger above is the primary guard for the connection role (which owns the table).
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;
