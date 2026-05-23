-- @scope: platform
-- ============================================================
-- 074_kv_plan_limits.sql
-- Add per-plan KV quotas: max ops/sec, storage, key count, value size.
-- ============================================================

-- ============================================================
-- 1. Add new columns to plans table
-- ============================================================

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS kv_max_ops_per_sec  integer NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS kv_max_storage_bytes bigint  NOT NULL DEFAULT 10485760,    -- 10 MB
  ADD COLUMN IF NOT EXISTS kv_max_keys_total    integer NOT NULL DEFAULT 100000,
  ADD COLUMN IF NOT EXISTS kv_max_value_bytes   integer NOT NULL DEFAULT 262144;      -- 256 KB

-- ============================================================
-- 2. Seed tier values (idempotent)
-- ============================================================

UPDATE plans SET
  kv_max_ops_per_sec   = 50,
  kv_max_storage_bytes = 10485760,
  kv_max_keys_total    = 100000,
  kv_max_value_bytes   = 262144
WHERE id = 'playground';

UPDATE plans SET
  kv_max_ops_per_sec   = 1000,
  kv_max_storage_bytes = 1073741824,                                  -- 1 GB
  kv_max_keys_total    = 1000000,
  kv_max_value_bytes   = 262144
WHERE id IN ('launch', 'certified');

UPDATE plans SET
  kv_max_ops_per_sec   = -1,                                          -- unlimited
  kv_max_storage_bytes = -1,                                          -- unlimited
  kv_max_keys_total    = -1,                                          -- unlimited
  kv_max_value_bytes   = 262144
WHERE id = 'enterprise';
