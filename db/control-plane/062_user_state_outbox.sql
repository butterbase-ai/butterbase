-- @scope: platform
-- Phase 3: outbox for user-billing-state CDC to runtime DBs.
-- Every UPDATE on platform_users.{plan_id, account_status, spending_cap_usd}
-- writes a paired row here in the same transaction. The state-outbox-drain
-- worker reads this table and pushes changes to each region's user_billing_state.

CREATE SEQUENCE IF NOT EXISTS user_state_outbox_version_seq;

CREATE TABLE user_state_outbox (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  fields_changed  JSONB       NOT NULL,
  version         BIGINT      NOT NULL DEFAULT nextval('user_state_outbox_version_seq'),
  -- regions where this version has been applied to user_billing_state
  applied_to_regions TEXT[]   NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at         TIMESTAMPTZ
);

CREATE INDEX user_state_outbox_pending_idx
  ON user_state_outbox (created_at)
  WHERE done_at IS NULL;

CREATE INDEX user_state_outbox_user_idx
  ON user_state_outbox (user_id, version DESC);

COMMENT ON TABLE user_state_outbox IS
  'Phase 3 hot-quota-path outbox. Drain worker propagates rows to per-region user_billing_state. See docs/runbooks/hot-quota-path.md.';
