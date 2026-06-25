-- @scope: runtime
-- 027_apps_substrate_autopropagate.sql
-- Adds per-event opt-in toggles for auto-mirroring app activity into the
-- linked owner's substrate. JSONB shape (v1):
--   { "users": true }  -- mirror signup / email_verified / user.delete
-- Default {} = all off. Only takes effect when substrate_user_id IS NOT NULL.

ALTER TABLE apps
  ADD COLUMN substrate_autopropagate jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN apps.substrate_autopropagate IS
  'Per-event opt-in for mirroring app activity into the linked owner''s substrate. Keys: users (bool). No-op when substrate_user_id IS NULL.';
