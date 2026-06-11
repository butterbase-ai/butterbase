-- @scope: platform
-- Per-app forward target for the meetings webhook fan-out.

CREATE TABLE app_meetings_webhooks (
  app_id                   TEXT PRIMARY KEY,
  forward_url              TEXT NOT NULL,
  -- Raw per-app webhook secret, AES-256-GCM encrypted with AUTH_ENCRYPTION_KEY
  -- via services/crypto.ts (iv:ciphertext:authTag, base64). The forwarder
  -- decrypts on each delivery and signs the outbound payload with HMAC-SHA256
  -- using the plaintext, so receivers can verify with the same secret they
  -- were handed at PUT / rotate time.
  forward_secret_encrypted TEXT NOT NULL,
  events                   TEXT[] NOT NULL DEFAULT ARRAY[
                             'bot.in_call_recording','bot.done','bot.fatal',
                             'recording.done','transcript.done','transcript.failed'
                           ]::TEXT[],
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
