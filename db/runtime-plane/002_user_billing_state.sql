-- @scope: runtime
-- Phase 3: per-region cache of user billing state.
-- Populated by:
--   - state-outbox-drain (slow fields)
--   - lease-client (topup_lease_remaining_usd, lease_expires_at)
-- Read by quota-enforcement plugin on every customer API request.

CREATE TABLE user_billing_state (
  user_id                     UUID         PRIMARY KEY,
  plan_id                     TEXT,
  account_status              TEXT,
  spending_cap_usd            NUMERIC(12,4),
  topup_lease_remaining_usd   NUMERIC(12,4) NOT NULL DEFAULT 0,
  lease_expires_at            TIMESTAMPTZ,
  last_outbox_version         BIGINT       NOT NULL DEFAULT 0,
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX user_billing_state_lease_expires_idx
  ON user_billing_state (lease_expires_at)
  WHERE topup_lease_remaining_usd > 0;

COMMENT ON TABLE user_billing_state IS
  'Phase 3 hot-quota-path local cache. user_id is a logical FK to platform_users (cross-tier).';
