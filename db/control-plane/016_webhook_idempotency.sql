-- @scope: platform
-- Webhook idempotency: prevent duplicate event processing
-- Stripe may retry webhooks for up to 3 days; we keep records for 30 days.

CREATE TABLE processed_webhook_events (
    stripe_event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_processed_webhook_events_processed_at
    ON processed_webhook_events(processed_at);
