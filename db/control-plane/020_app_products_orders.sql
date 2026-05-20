-- @scope: platform
-- App products and orders schema (Stripe Connect one-time payments)
-- Enables developers to sell products (not subscriptions) to their app users

-- Developer-defined products for sale
CREATE TABLE app_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'usd',
    active BOOLEAN DEFAULT true,
    stripe_product_id TEXT,  -- Optional: for Stripe Product sync
    stripe_price_id TEXT,    -- Optional: for Stripe Price sync
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_app_products_app_id ON app_products(app_id);
CREATE INDEX idx_app_products_active ON app_products(app_id, active);

-- End-user purchase records
CREATE TABLE app_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES app_products(id),
    stripe_checkout_session_id TEXT UNIQUE NOT NULL,
    stripe_payment_intent_id TEXT,
    amount_cents INTEGER NOT NULL,
    platform_fee_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, paid, failed, refunded
    refunded_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_app_orders_app_id ON app_orders(app_id);
CREATE INDEX idx_app_orders_user_id ON app_orders(user_id);
CREATE INDEX idx_app_orders_status ON app_orders(app_id, status);
CREATE INDEX idx_app_orders_stripe_session ON app_orders(stripe_checkout_session_id);
