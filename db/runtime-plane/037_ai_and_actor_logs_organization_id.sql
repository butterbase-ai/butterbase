-- @scope: runtime
-- Plan 11.1: add organization_id to AI-gateway usage logs. Logical cross-plane
-- reference to control-plane organizations(id). Nullable until Plan 11.5.

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS ai_usage_logs_organization_id_idx
  ON ai_usage_logs (organization_id) WHERE organization_id IS NOT NULL;
COMMENT ON COLUMN ai_usage_logs.organization_id IS
  'Which org this AI gateway call is billed against. Nullable until Plan 11.5.';

ALTER TABLE actor_usage_logs
  ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS actor_usage_logs_organization_id_idx
  ON actor_usage_logs (organization_id) WHERE organization_id IS NOT NULL;
COMMENT ON COLUMN actor_usage_logs.organization_id IS
  'Which org this actor invocation is attributed to. Nullable until Plan 11.5.';

ALTER TABLE ai_video_jobs
  ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS ai_video_jobs_organization_id_idx
  ON ai_video_jobs (organization_id) WHERE organization_id IS NOT NULL;
COMMENT ON COLUMN ai_video_jobs.organization_id IS
  'Which org this video job bills. Nullable until Plan 11.5.';
