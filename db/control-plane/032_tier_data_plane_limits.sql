-- @scope: platform
-- ============================================================
-- 032_tier_data_plane_limits.sql
-- Add per-plan data-plane limits: request rate, realtime
-- listeners per app, and Postgres statement_timeout.
-- -1 means "unlimited" (consistent with existing columns).
-- ============================================================

-- ============================================================
-- 1. Add new columns to plans table
-- ============================================================

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS max_requests_per_min INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS max_realtime_listeners_per_app INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS statement_timeout_ms INTEGER NOT NULL DEFAULT 15000;

-- ============================================================
-- 2. Seed tier values (idempotent)
-- ============================================================

UPDATE plans SET
  max_requests_per_min = 300,
  max_realtime_listeners_per_app = 20,
  statement_timeout_ms = 15000
WHERE id = 'playground';

UPDATE plans SET
  max_requests_per_min = 3000,
  max_realtime_listeners_per_app = 200,
  statement_timeout_ms = 30000
WHERE id IN ('launch', 'certified');

UPDATE plans SET
  max_requests_per_min = -1,
  max_realtime_listeners_per_app = -1,
  statement_timeout_ms = 60000
WHERE id = 'enterprise';
