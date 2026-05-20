-- @scope: platform
-- Add stripe_event_id column to billing_events (was added to 013_billing.sql
-- after that migration had already been applied in production).
ALTER TABLE billing_events ADD COLUMN IF NOT EXISTS stripe_event_id TEXT;
