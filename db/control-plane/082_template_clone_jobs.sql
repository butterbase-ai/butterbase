-- @scope: platform
-- Template clone jobs — global, control-plane (one row per clone operation).
CREATE TABLE IF NOT EXISTS template_clone_jobs (
  id                   TEXT PRIMARY KEY,        -- 'cj_' + 24 url-safe chars
  source_app_id        TEXT NOT NULL,           -- the public template's app id (FK is loose — public app may be in any region)
  source_snapshot_id   TEXT NOT NULL,           -- pinned at job-create time
  source_region        TEXT NOT NULL,           -- e.g. 'us-east-1' — where the source's blobs live
  dest_app_id          TEXT,                    -- assigned by the worker once init_app completes
  dest_region          TEXT NOT NULL,           -- where the new app is provisioned
  requested_by_user_id TEXT NOT NULL,           -- the actor; owner of the cloned app once complete
  dest_app_name        TEXT,                    -- optional rename at clone-create time
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  retry_count          INT NOT NULL DEFAULT 0,
  error_message        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_template_clone_jobs_source_app
  ON template_clone_jobs (source_app_id) WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_template_clone_jobs_user
  ON template_clone_jobs (requested_by_user_id, created_at DESC);
