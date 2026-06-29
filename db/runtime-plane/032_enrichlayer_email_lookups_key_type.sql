-- @scope: runtime
-- 032_enrichlayer_email_lookups_key_type.sql
-- Add key_type to enrichlayer_email_lookups so the async-email webhook can
-- distinguish BYOK requests (skip Butterbase billing — already billed at vendor)
-- from platform-key requests (charge user's credit pool).
ALTER TABLE enrichlayer_email_lookups
  ADD COLUMN IF NOT EXISTS key_type text NOT NULL DEFAULT 'platform'
  CHECK (key_type IN ('platform', 'byok'));
