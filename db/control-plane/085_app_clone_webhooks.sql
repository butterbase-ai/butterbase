-- @scope: platform
-- 085: Per-app webhook configuration for clone_completed events.
--
-- v1 design: one webhook URL + encrypted secret per app.
-- Forward-compat: separate table (not columns on apps) so future phases
-- can add rows for other event types without a schema change.
--
-- webhook_secret_encrypted stores the HMAC signing secret encrypted with
-- AES-256-GCM using AUTH_ENCRYPTION_KEY. Never log or return the plaintext.
--
-- clone_webhook_outbox is the delivery queue. Each clone completion inserts
-- one row per webhook registered on either the source or dest app. The
-- webhook sweeper delivers and retries with exponential backoff (max 3).

BEGIN;

CREATE TABLE IF NOT EXISTS app_clone_webhooks (
  app_id                   text PRIMARY KEY,
  webhook_url              text NOT NULL,
  webhook_secret_encrypted text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_clone_webhooks IS
  'One webhook endpoint per app; receives signed clone_completed POSTs.';

CREATE TABLE IF NOT EXISTS clone_webhook_outbox (
  id              text PRIMARY KEY DEFAULT 'cwh_' || gen_random_uuid()::text,
  app_id          text NOT NULL,
  job_id          text NOT NULL,
  source_app_id   text NOT NULL,
  dest_app_id     text,
  dest_region     text NOT NULL,
  completed_at    timestamptz NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clone_webhook_outbox_pending
  ON clone_webhook_outbox (next_attempt_at)
  WHERE delivered_at IS NULL;

COMMENT ON TABLE clone_webhook_outbox IS
  'Delivery queue for clone_completed webhook POSTs. Sweeper retries with exponential backoff (3 attempts max).';

COMMIT;
