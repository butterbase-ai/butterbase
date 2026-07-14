-- @scope: runtime
-- 046: Add ai_image_jobs table for async image-generation jobs through the AI gateway.
-- One row per submission. Customer polls /v1/:appId/images/completions/:jobId, which
-- lazily forwards to upstream when status is non-terminal. Billing settled on first
-- terminal transition using actual upstream cost or catalog fallback.

BEGIN;

CREATE TABLE ai_image_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  organization_id       UUID NOT NULL,
  user_id               TEXT NOT NULL,
  end_user_sub          TEXT,
  model                 TEXT NOT NULL,
  request_json          JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled', 'expired')),
  upstream_router       TEXT NOT NULL,
  upstream_job_id       TEXT NOT NULL,
  upstream_polling_url  TEXT NOT NULL,
  unsigned_urls         JSONB,
  content_type          TEXT,
  error                 TEXT,
  lease_id              UUID NOT NULL,
  estimated_cost_usd    NUMERIC(12, 6) NOT NULL,
  provider_cost_usd     NUMERIC(12, 6),
  charged_credits_usd   NUMERIC(12, 6),
  markup_pct            NUMERIC(6, 3) NOT NULL,
  settled_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_image_jobs_app_id  ON ai_image_jobs (app_id, created_at DESC);
CREATE INDEX idx_ai_image_jobs_user_id ON ai_image_jobs (user_id, created_at DESC);
CREATE INDEX idx_ai_image_jobs_status  ON ai_image_jobs (status) WHERE status IN ('pending', 'in_progress');

COMMENT ON TABLE  ai_image_jobs IS
  'Async image-generation jobs through /v1/:appId/images/completions. Lazy poll, settled on terminal status.';
COMMENT ON COLUMN ai_image_jobs.settled_at IS
  'Set when first terminal status was observed and billing was settled. NULL means lease still outstanding.';
COMMENT ON COLUMN ai_image_jobs.content_type IS
  'MIME type of the generated image (image/png|jpeg|webp). Populated on completed; NULL otherwise.';

COMMIT;
