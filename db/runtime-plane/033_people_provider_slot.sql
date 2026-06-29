-- @scope: runtime
-- 033_people_provider_slot.sql
-- Adds a provider_slot column to people audit + cache tables so multi-provider
-- routing can be attributed in usage analytics. Default 'primary' is safe for
-- existing rows (single-provider deployment). CHECK constraint allows
-- extension to 'tertiary' etc. by ALTER TABLE in a future migration.

ALTER TABLE people_usage_logs
  ADD COLUMN IF NOT EXISTS provider_slot text NOT NULL DEFAULT 'primary'
  CHECK (provider_slot IN ('primary', 'secondary'));

ALTER TABLE people_profile_cache
  ADD COLUMN IF NOT EXISTS provider_slot text NOT NULL DEFAULT 'primary'
  CHECK (provider_slot IN ('primary', 'secondary'));

ALTER TABLE people_email_lookups
  ADD COLUMN IF NOT EXISTS provider_slot text NOT NULL DEFAULT 'primary'
  CHECK (provider_slot IN ('primary', 'secondary'));

CREATE INDEX IF NOT EXISTS idx_people_usage_provider_created
  ON people_usage_logs (provider_slot, created_at DESC);
