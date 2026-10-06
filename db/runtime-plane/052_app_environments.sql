-- @scope: runtime
-- Links a production app to its staging sibling. Both apps are ordinary rows in
-- `apps`; this table is the only thing that makes the pair first-class.
--
-- Same-region invariant: this table lives in a regional runtime DB, so both FKs
-- resolve locally. A staging app is therefore always created in its production
-- app's region. Do not add a cross-region path without moving this table.
CREATE TABLE IF NOT EXISTS app_environments (
  prod_app_id       TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  staging_app_id    TEXT NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
  created_by        UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_promoted_at  TIMESTAMPTZ NULL,
  last_reset_at     TIMESTAMPTZ NULL,
  CONSTRAINT app_environments_distinct CHECK (prod_app_id <> staging_app_id)
);

COMMENT ON TABLE app_environments IS
  'One row per production app that has a staging sibling. prod_app_id is the PK, so an app has at most one staging environment; staging_app_id is UNIQUE, so a staging app serves exactly one production app.';
