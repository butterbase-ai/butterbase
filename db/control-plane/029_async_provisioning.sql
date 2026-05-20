-- @scope: platform
-- Add provisioning status tracking for async app provisioning
ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS provisioning_status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (provisioning_status IN ('provisioning', 'ready', 'failed')),
  ADD COLUMN IF NOT EXISTS provisioning_error TEXT;

-- Backfill: existing provisioned apps are 'ready', unprovisioned are 'provisioning'
UPDATE apps SET provisioning_status = 'ready' WHERE db_provisioned = true;
UPDATE apps SET provisioning_status = 'provisioning' WHERE db_provisioned = false;
