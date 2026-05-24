-- @scope: runtime
-- 012: Add ai_video_jobs table for async video-generation jobs through the AI gateway.
-- One row per submission. Customer polls /v1/:appId/videos/completions/:jobId, which
-- lazily forwards to upstream when status is non-terminal. Billing settled on first
-- terminal transition using actual upstream cost.

BEGIN;

CREATE TABLE ai_video_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL,
  model                 TEXT NOT NULL,
  request_json          JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled', 'expired')),
  upstream_router       TEXT NOT NULL,
  upstream_job_id       TEXT NOT NULL,
  upstream_polling_url  TEXT NOT NULL,
  unsigned_urls         JSONB,
  error                 TEXT,
  lease_id              TEXT NOT NULL,
  estimated_cost_usd    NUMERIC(12, 4) NOT NULL,
  provider_cost_usd     NUMERIC(12, 4),
  charged_credits_usd   NUMERIC(12, 4),
  markup_pct            NUMERIC(6, 2) NOT NULL,
  settled_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_video_jobs_app_id      ON ai_video_jobs (app_id, created_at DESC);
CREATE INDEX idx_ai_video_jobs_user_id     ON ai_video_jobs (user_id, created_at DESC);
CREATE INDEX idx_ai_video_jobs_status      ON ai_video_jobs (status) WHERE status IN ('pending', 'in_progress');

COMMENT ON TABLE  ai_video_jobs IS
  'Async video-generation jobs through /v1/:appId/videos/completions. Lazy poll, settled on terminal status.';
COMMENT ON COLUMN ai_video_jobs.settled_at IS
  'Set when first terminal status was observed and billing was settled. NULL means lease still outstanding.';

COMMIT;
