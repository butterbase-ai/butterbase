-- @scope: platform
-- 084_fork_count_decrements.sql
-- B2: Cross-region fork_count decrement outbox.
--
-- When a cloned app is deleted and the source app lives in a different region,
-- a runtime-plane DELETE trigger cannot decrement the remote fork_count (triggers
-- are local to their region's DB).  Instead the delete handler inserts a row
-- here; the fork-count sweeper in control-api processes it every 30 s, debiting
-- source.fork_count via the appropriate per-region runtime pool, then marking
-- the row processed.

CREATE TABLE fork_count_decrements (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_app_id TEXT      NOT NULL,
  source_region TEXT      NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Partial index: only unprocessed rows are ever scanned by the sweeper.
CREATE INDEX idx_fork_decrements_unprocessed
  ON fork_count_decrements (created_at)
  WHERE processed_at IS NULL;
