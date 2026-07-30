-- @scope: platform
-- 096: Codify the organizations.auto_refill_* columns that were added ad-hoc
-- to prod as part of the per-org billing split rollout, but never captured in
-- a tracked control-plane migration.
--
-- Prior state:
--   - Migration 066 added auto_refill_enabled / auto_refill_amount_usd /
--     auto_refill_last_attempt_at / auto_refill_last_failure_reason to
--     platform_users.
--   - Migration 093 moved billing state (monthly_allowance_usd, credits_usd)
--     from platform_users to organizations, and left a follow-up plan to drop
--     the per-user columns "after readers/writers are cut over".
--   - Auto-refill readers were updated to read from `organizations` (see
--     auto-refill.ts, ai-config.ts, admin.ts, auto-refill-service.ts) and prod
--     grew the columns on `organizations` via a manual ALTER — but no
--     migration file captured that. Fresh installs and staging drift from prod
--     as a result.
--
-- This migration adds the columns idempotently (ADD COLUMN IF NOT EXISTS).
-- Prod already has them, so this is a no-op there. Staging / dev / any future
-- restore-from-migrations gets them added.
--
-- The stale platform_users.auto_refill_* columns are intentionally NOT dropped
-- here — a separate cleanup migration should verify no readers remain before
-- dropping (see credits-email.ts fix that ships alongside this migration).

BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS auto_refill_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_refill_amount_usd         NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS auto_refill_last_attempt_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_refill_last_failure_reason TEXT;

COMMIT;
