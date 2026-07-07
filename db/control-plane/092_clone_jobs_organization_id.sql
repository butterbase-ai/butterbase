-- template_clone_jobs.dest_organization_id
--
-- Records the org the destination clone should land in. Populated by
-- POST /v1/templates/:source_app_id/clone from the same precedence used
-- by /init (body.organization_id → auth.organizationId → personal org).
-- The worker reads this at insertAppRow / addOrgAppIndex time instead of
-- re-resolving personal org.
--
-- Nullable so pending pre-migration rows keep processing; the worker falls
-- back to resolveOrganizationId(user) for a NULL value.

ALTER TABLE template_clone_jobs
  ADD COLUMN IF NOT EXISTS dest_organization_id uuid REFERENCES organizations(id);
