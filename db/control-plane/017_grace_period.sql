-- @scope: platform
-- Grace period tracking for payment failures
-- After invoice.payment_failed, accounts get 7 days before suspension.

ALTER TABLE subscriptions
    ADD COLUMN grace_period_ends_at TIMESTAMPTZ;

ALTER TABLE app_subscriptions
    ADD COLUMN grace_period_ends_at TIMESTAMPTZ;

-- Index for efficient grace period expiry checks (nightly cron)
CREATE INDEX idx_subscriptions_grace_period
    ON subscriptions(grace_period_ends_at)
    WHERE status = 'past_due' AND grace_period_ends_at IS NOT NULL;

CREATE INDEX idx_app_subscriptions_grace_period
    ON app_subscriptions(grace_period_ends_at)
    WHERE status = 'past_due' AND grace_period_ends_at IS NOT NULL;
