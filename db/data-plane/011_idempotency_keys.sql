-- @scope: data
-- 011_idempotency_keys.sql
-- Per-app store for the ctx.idempotency.claim() runtime primitive.
-- Lets webhook handlers atomically claim "I am the first to process this event id"
-- so retries from third-party providers (Stripe, Telegram, GitHub, Slack, Twilio,
-- Discord) don't double-process.
--
-- The user is responsible for cleanup. The recommended snippet is documented in
-- the function-runtime docs:
--   DELETE FROM _idempotency_keys WHERE expires_at < now();
-- The partial index on expires_at keeps that delete cheap.

CREATE TABLE IF NOT EXISTS _idempotency_keys (
  key          TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'default',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
  ON _idempotency_keys (expires_at) WHERE expires_at IS NOT NULL;

-- Only the platform-trusted role can read/write claims. End-user and anon roles
-- never touch this table; the runtime always elevates to butterbase_service for
-- ctx.idempotency.claim().
GRANT SELECT, INSERT, DELETE ON _idempotency_keys TO butterbase_service;
