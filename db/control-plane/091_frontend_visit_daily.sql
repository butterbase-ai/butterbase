-- @scope: platform
-- Per-app daily rollup of deployed-frontend visits. Populated by the dispatch
-- worker's beacon; read by admin dashboard for the 'is this project active?' view.
-- `unique_visitor_count` is an approximation — batched from the edge, dedupe is per-batch not per-day.

CREATE TABLE IF NOT EXISTS frontend_visit_daily (
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    unique_visitor_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (app_id, day)
);

CREATE INDEX IF NOT EXISTS idx_frontend_visit_day
  ON frontend_visit_daily (day DESC);
