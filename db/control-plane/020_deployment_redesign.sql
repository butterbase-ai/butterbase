-- @scope: platform
-- Frontend deployment redesign: two-phase upload with R2 and webhooks

-- Add new columns to app_deployments for two-phase flow
ALTER TABLE app_deployments
  ADD COLUMN r2_object_key TEXT,                    -- R2 key for uploaded zip
  ADD COLUMN upload_expires_at TIMESTAMPTZ,         -- Presigned URL expiry
  ADD COLUMN started_at TIMESTAMPTZ,                -- When /start was called
  ADD COLUMN completed_at TIMESTAMPTZ;              -- When deployment finished

-- Add index for webhook lookups by Cloudflare deployment ID
CREATE INDEX idx_app_deployments_cloudflare_id
  ON app_deployments(cloudflare_deployment_id)
  WHERE cloudflare_deployment_id IS NOT NULL;

-- Update webhook idempotency table to support multiple sources
ALTER TABLE processed_webhook_events
  RENAME COLUMN stripe_event_id TO event_id;

ALTER TABLE processed_webhook_events
  ADD COLUMN source TEXT NOT NULL DEFAULT 'stripe';

-- Update index for multi-source webhooks
DROP INDEX IF EXISTS idx_processed_webhook_events_processed_at;
CREATE INDEX idx_processed_webhook_events_source_processed_at
  ON processed_webhook_events(source, processed_at);

-- Update primary key to include source (event_id may not be unique across sources)
ALTER TABLE processed_webhook_events DROP CONSTRAINT processed_webhook_events_pkey;
ALTER TABLE processed_webhook_events ADD PRIMARY KEY (source, event_id);
