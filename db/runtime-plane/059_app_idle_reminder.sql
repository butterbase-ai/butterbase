-- @scope: runtime
-- Durable deduplication for the reminder between the first warning and notice.
-- Nullable and additive: old images ignore it. Apply before deploying new code.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS idle_reminded_at timestamptz;
