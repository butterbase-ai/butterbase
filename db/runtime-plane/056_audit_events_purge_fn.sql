-- @scope: runtime
-- F-05: plan-tiered audit retention on the runtime plane + revoke app-role write access.
--
-- The runtime plane has no direct access to control-plane organizations/plans,
-- so the enterprise org set is passed in as a parameter by the nightly cron
-- (queried from the control plane before dispatching to each region).
--
-- purge_audit_events(enterprise_org_ids uuid[])
--   enterprise_org_ids  IDs of organizations on plans with audit_retention_days > 180.
--                       Defaults to empty array (all rows use the 180-day floor).
-- Returns the number of rows deleted.
-- SECURITY DEFINER: owned by the schema owner so UPDATE/DELETE can be revoked
-- from the application role while the nightly cron still purges via this function.

CREATE OR REPLACE FUNCTION purge_audit_events(enterprise_org_ids uuid[] DEFAULT '{}')
  RETURNS bigint
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  WITH deleted AS (
    DELETE FROM audit_events
    WHERE created_at < CASE
      WHEN organization_id = ANY(enterprise_org_ids) THEN now() - interval '365 days'
      ELSE now() - interval '180 days'
    END
    RETURNING id
  )
  SELECT count(*)::bigint FROM deleted;
$$;

COMMENT ON FUNCTION purge_audit_events(uuid[]) IS
  'Plan-tiered audit log retention purge. Enterprise orgs keep 12 months; all others 180 days.';

REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;
