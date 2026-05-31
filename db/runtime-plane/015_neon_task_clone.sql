-- @scope: runtime
-- Add 'clone' to neon_tasks.task_type CHECK + a task_meta JSONB column.
-- The clone worker needs the column to carry the job_id (and any future
-- task-specific payload); folding both changes here so we don't have
-- two migrations.
--
-- The CHECK is unnamed in the original 030_neon_task_queue migration, so
-- Postgres auto-names it; drop + recreate safely.
DO $$
BEGIN
  PERFORM 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'neon_tasks' AND column_name = 'task_type';
  IF FOUND THEN
    EXECUTE (
      SELECT string_agg('ALTER TABLE neon_tasks DROP CONSTRAINT ' || quote_ident(conname), '; ')
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
      WHERE c.conrelid = 'neon_tasks'::regclass
        AND a.attname = 'task_type'
        AND c.contype = 'c'
    );
  END IF;
END $$;

ALTER TABLE neon_tasks ADD CONSTRAINT neon_tasks_task_type_check
  CHECK (task_type IN ('provision', 'deprovision', 'clone'));

ALTER TABLE neon_tasks ADD COLUMN IF NOT EXISTS task_meta JSONB;
