-- @scope: runtime
-- 013: Add end_user_sub to ai_video_jobs for per-end-user job isolation.
-- When a job is submitted via an end-user JWT (iss = butterbase:app:<appId>),
-- we stamp the end-user's `sub` claim on the row. The GET handlers then scope
-- visibility: owners and app-scoped API keys see every job in the app;
-- end-users see only jobs they themselves submitted (matching `end_user_sub`).
-- NULL = submitted by the owner (or by a scoped key acting on the owner's behalf).

BEGIN;

ALTER TABLE ai_video_jobs ADD COLUMN end_user_sub TEXT;

-- Lookup pattern: GET /v1/:appId/videos/completions/:jobId by an end-user
-- filters by (app_id, id, end_user_sub). The existing app_id index covers
-- listing; this partial index speeds the per-end-user case without paying
-- index-cost on owner-submitted rows.
CREATE INDEX idx_ai_video_jobs_end_user
  ON ai_video_jobs (app_id, end_user_sub)
  WHERE end_user_sub IS NOT NULL;

COMMENT ON COLUMN ai_video_jobs.end_user_sub IS
  'End-user subject from the app-scoped JWT that submitted this job. NULL when submitted by the app owner or an app-scoped API key. End-user GETs are restricted to rows matching their own sub.';

COMMIT;
