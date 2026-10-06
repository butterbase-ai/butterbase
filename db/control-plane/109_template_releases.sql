-- @scope: platform
-- Template releases + fork lineage.
--
-- template_releases: immutable, insert-only. One row per published release of a
--   public template. release_number is monotonic per source_app_id and is the sole
--   basis for ordering and drift; `label` is display text only. Deleting a release
--   would strand every fork pointing at it as their base, so there is no delete path.
--
-- app_lineage: one row per fork. Control-plane rather than runtime because
--   "all forks of app X" spans regions; keeping it per-region is what produced the
--   fork_count gap documented in routes/templates-discovery.ts.
--
-- base resolution (exactly one of these is set):
--   base_release_id  -> the fork's base is that release's manifest
--   base_fingerprint -> fork was cloned from live; base is materialized inline
--   both NULL        -> fork predates capture; no trustworthy backend base

CREATE TABLE IF NOT EXISTS template_releases (
  id              TEXT PRIMARY KEY,          -- 'rel_' + 24 url-safe chars
  source_app_id   TEXT        NOT NULL,
  release_number  INT         NOT NULL,
  label           TEXT        NULL,
  snapshot_id     TEXT        NOT NULL,
  manifest        JSONB       NOT NULL,
  notes           TEXT        NULL,
  published_by    TEXT        NOT NULL,
  published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_app_id, release_number)
);

CREATE INDEX IF NOT EXISTS idx_template_releases_source
  ON template_releases (source_app_id, release_number DESC);

CREATE TABLE IF NOT EXISTS app_lineage (
  dest_app_id      TEXT        PRIMARY KEY,
  dest_region      TEXT        NOT NULL,
  source_app_id    TEXT        NOT NULL,
  source_region    TEXT        NOT NULL,
  base_release_id  TEXT        NULL REFERENCES template_releases(id),
  base_fingerprint JSONB       NULL,
  base_snapshot_id TEXT        NULL,
  severed_at       TIMESTAMPTZ NULL,
  cloned_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_lineage_source
  ON app_lineage (source_app_id) WHERE severed_at IS NULL;

COMMENT ON COLUMN app_lineage.base_fingerprint IS
  'captureAppState() output. Set only when base_release_id IS NULL (cloned from live). Both NULL = fork predates capture; no trustworthy backend base.';
COMMENT ON COLUMN app_lineage.severed_at IS
  'When set, the fork owner declared independence; all drift signalling stops. Lineage is retained for attribution.';
