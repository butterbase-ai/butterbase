-- @scope: platform
-- Phase 3: lease ledger for region-held top-up balance.
-- Each row represents a region's claim on a slice of platform_users.topup_balance_usd.
-- The reclaim cron returns expired unspent leases.

CREATE TABLE topup_leases (
  lease_id     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  region       TEXT         NOT NULL,
  amount_usd   NUMERIC(12,4) NOT NULL CHECK (amount_usd > 0),
  granted_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ  NOT NULL,
  status       TEXT         NOT NULL CHECK (status IN ('active', 'expired', 'reclaimed', 'returned')),
  reclaimed_at TIMESTAMPTZ
);

CREATE INDEX topup_leases_active_user_region_idx
  ON topup_leases (user_id, region)
  WHERE status = 'active';

CREATE INDEX topup_leases_reclaim_idx
  ON topup_leases (expires_at)
  WHERE status = 'active';

COMMENT ON TABLE topup_leases IS
  'Phase 3 lease ledger. Each row = one regional claim on topup_balance_usd. Reclaim cron returns expired ones.';
