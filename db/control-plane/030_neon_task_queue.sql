-- @scope: platform
-- Extend provisioning_status to include 'deleting'
-- The unnamed CHECK from 029 gets auto-named by Postgres; drop + recreate safely
DO $$
BEGIN
  PERFORM 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'apps' AND column_name = 'provisioning_status';
  IF FOUND THEN
    EXECUTE (
      SELECT string_agg('ALTER TABLE apps DROP CONSTRAINT ' || quote_ident(conname), '; ')
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
      WHERE c.conrelid = 'apps'::regclass
        AND a.attname = 'provisioning_status'
        AND c.contype = 'c'
    );
  END IF;
END $$;

ALTER TABLE apps ADD CONSTRAINT apps_provisioning_status_check
  CHECK (provisioning_status IN ('provisioning', 'ready', 'failed', 'deleting'));

-- Task queue for serialized Neon DB operations
CREATE TABLE IF NOT EXISTS neon_tasks (
  id           BIGSERIAL PRIMARY KEY,
  app_id       TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  task_type    TEXT NOT NULL CHECK (task_type IN ('provision', 'deprovision')),
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts     INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  last_error   TEXT,
  locked_at    TIMESTAMPTZ,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Worker picks oldest runnable pending task
CREATE INDEX IF NOT EXISTS idx_neon_tasks_pending
  ON neon_tasks (run_after ASC) WHERE status = 'pending';

-- Prevent duplicate active tasks per app+type
CREATE UNIQUE INDEX IF NOT EXISTS idx_neon_tasks_active_unique
  ON neon_tasks (app_id, task_type) WHERE status IN ('pending', 'processing');
