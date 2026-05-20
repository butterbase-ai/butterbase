-- @scope: platform
-- App billing schema (Stripe Connect)
-- Enables developers to accept payments from their app users

-- Developer-defined subscription plans for their apps
CREATE TABLE app_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    interval TEXT NOT NULL DEFAULT 'month',  -- month, year
    features JSONB DEFAULT '[]',
    stripe_price_id TEXT,  -- Stripe Price ID (for Connect)
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_app_plans_app_id ON app_plans(app_id);
CREATE INDEX idx_app_plans_active ON app_plans(app_id, active);

-- End-user subscriptions to app plans
CREATE TABLE app_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES app_plans(id),
    stripe_subscription_id TEXT UNIQUE,
    stripe_customer_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',  -- active, past_due, canceled, trialing
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_id, user_id)  -- One subscription per user per app
);
CREATE INDEX idx_app_subscriptions_app_id ON app_subscriptions(app_id);
CREATE INDEX idx_app_subscriptions_user_id ON app_subscriptions(user_id);
CREATE INDEX idx_app_subscriptions_stripe_subscription_id ON app_subscriptions(stripe_subscription_id);

-- Add Stripe Connect account ID to apps table
ALTER TABLE apps ADD COLUMN stripe_connect_account_id TEXT UNIQUE;
CREATE INDEX idx_apps_stripe_connect_account_id ON apps(stripe_connect_account_id);

-- Add AI config to apps table (for Phase 7)
ALTER TABLE apps ADD COLUMN ai_config JSONB DEFAULT '{}';
