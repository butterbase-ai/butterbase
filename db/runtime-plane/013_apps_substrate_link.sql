-- @scope: runtime
-- Link runtime-plane apps to substrate-plane users. Soft FK only —
-- substrate.users lives in a different Neon project, so no real REFERENCES.
-- API-layer enforcement (control-api routes) must ensure the substrate_user_id
-- matches the app owner's platform_users.id.

ALTER TABLE apps
  ADD COLUMN substrate_user_id uuid NULL;

CREATE INDEX apps_substrate_user_idx
  ON apps(substrate_user_id)
  WHERE substrate_user_id IS NOT NULL;

COMMENT ON COLUMN apps.substrate_user_id IS
  'Platform user whose substrate this app reads/writes via ctx.substrate.
   NULL = app is not linked to substrate (ctx.substrate is undefined inside the worker).
   Set this from the control-api route that owns app-substrate linking.';
