-- @scope: platform
-- Platform billing schema
-- Enables usage-based billing with Stripe integration

-- Plan definitions (free, starter, pro, enterprise)
CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_monthly_cents INTEGER NOT NULL,
    max_apps INTEGER NOT NULL,                  -- -1 = unlimited
    max_api_calls_monthly INTEGER NOT NULL,     -- -1 = unlimited
    max_storage_gb NUMERIC(10,2) NOT NULL,      -- -1 = unlimited
    max_ai_tokens_monthly BIGINT NOT NULL,      -- -1 = unlimited
    max_lambda_invocations INTEGER NOT NULL,    -- -1 = unlimited
    max_db_size_gb NUMERIC(10,2) NOT NULL,      -- -1 = unlimited
    max_bandwidth_gb NUMERIC(10,2) NOT NULL,    -- -1 = unlimited
    features JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insert default plans
INSERT INTO plans (id, name, price_monthly_cents, max_apps, max_api_calls_monthly, max_storage_gb,
                   max_ai_tokens_monthly, max_lambda_invocations, max_db_size_gb, max_bandwidth_gb, features)
VALUES
('free', 'Free', 0, -1, -1, -1, -1, -1, -1, -1,
 '{}');
-- User subscriptions
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES plans(id),
    stripe_subscription_id TEXT UNIQUE,
    stripe_customer_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',  -- active, past_due, canceled, trialing
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_subscription_id ON subscriptions(stripe_subscription_id);

-- Usage meters (aggregated by user/app/meter/period)
CREATE TABLE usage_meters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
    meter_type TEXT NOT NULL,  -- api_calls, storage_bytes, ai_tokens, lambda_invocations, bandwidth_bytes
    period_start DATE NOT NULL,
    quantity BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, app_id, meter_type, period_start)
);
CREATE INDEX idx_usage_meters_lookup ON usage_meters(user_id, meter_type, period_start);
CREATE INDEX idx_usage_meters_app ON usage_meters(app_id, meter_type, period_start);

-- Billing events audit log
CREATE TABLE billing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,  -- subscription_created, subscription_updated, payment_succeeded, payment_failed, etc.
    stripe_event_id TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_billing_events_user_id ON billing_events(user_id);
CREATE INDEX idx_billing_events_created_at ON billing_events(created_at);

-- Add billing columns to platform_users
ALTER TABLE platform_users
    ADD COLUMN plan_id TEXT DEFAULT 'free' REFERENCES plans(id),
    ADD COLUMN stripe_customer_id TEXT UNIQUE,
    ADD COLUMN billing_period_start DATE,
    ADD COLUMN account_status TEXT DEFAULT 'active';  -- active, soft_locked, suspended

CREATE INDEX idx_platform_users_plan_id ON platform_users(plan_id);
CREATE INDEX idx_platform_users_account_status ON platform_users(account_status);
