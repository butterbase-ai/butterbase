-- @scope: platform
-- Phase 5: app move-app saga state. One row per migration attempt.
-- Exclusion constraint prevents two in-flight migrations for the same app.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE app_migrations (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                TEXT          NOT NULL,
  user_id               UUID          NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  source_region         TEXT          NOT NULL,
  dest_region           TEXT          NOT NULL,
  current_step          TEXT          NOT NULL DEFAULT 'requested',
  step_started_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  last_error            TEXT,
  retry_count           INT           NOT NULL DEFAULT 0,
  dest_resources        JSONB         NOT NULL DEFAULT '{}'::jsonb,
  source_replica_state  TEXT,
  initiated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  CONSTRAINT one_active_migration_per_app
    EXCLUDE USING GIST (app_id WITH =)
    WHERE (current_step NOT IN ('completed','aborted','failed'))
);

CREATE INDEX app_migrations_by_user_idx ON app_migrations (user_id, initiated_at DESC);
CREATE INDEX app_migrations_pending_idx ON app_migrations (current_step, step_started_at)
  WHERE current_step NOT IN ('completed','aborted','failed');
CREATE INDEX app_migrations_source_replica_idx ON app_migrations (source_replica_state)
  WHERE source_replica_state = 'replicating';

COMMENT ON TABLE app_migrations IS
  'Phase 5: move-app saga state. One row per migration attempt.';
COMMENT ON COLUMN app_migrations.current_step IS
  'Enum: requested | reserving_dest | blocking_writes | dumping_data | restoring_data | copying_blobs | copying_runtime | flipping_routing | setting_up_reverse_replication | unblocking_writes | completed | aborting | aborted | failed';
COMMENT ON COLUMN app_migrations.source_replica_state IS
  'After cutover, tracks the post-migration source-side data DB: none | replicating | torn_down';
