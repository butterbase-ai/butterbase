-- @scope: control
-- Per-app forward target for the meetings webhook fan-out.

CREATE TABLE app_meetings_webhooks (
  app_id              TEXT PRIMARY KEY,
  forward_url         TEXT NOT NULL,
  forward_secret_hash TEXT NOT NULL,
  events              TEXT[] NOT NULL DEFAULT ARRAY[
                        'bot.in_call_recording','bot.done','bot.fatal',
                        'recording.done','transcript.done','transcript.failed'
                      ]::TEXT[],
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
