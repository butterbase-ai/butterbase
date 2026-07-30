-- @scope: runtime
-- 047: Add organization_id index to ai_image_jobs for billing/analytics query patterns.
-- Matches migration 037's pattern for ai_video_jobs.

BEGIN;

CREATE INDEX idx_ai_image_jobs_organization_id ON ai_image_jobs (organization_id, created_at DESC);

COMMIT;
