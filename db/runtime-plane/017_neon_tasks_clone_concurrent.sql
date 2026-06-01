-- Allow multiple concurrent clone tasks per source app.
-- Other task types (provision, deprovision) keep the single-active-per-app constraint.
--
-- The old idx_neon_tasks_active_unique covered (app_id, task_type) for ALL
-- task types, which prevented two pending/processing clone tasks for the same
-- source app.  The clone route worked around this by DELETE-ing any prior row
-- before INSERT-ing the new one, which clobbered a still-running concurrent clone.
--
-- The new index excludes clone so multiple clone neon_tasks rows can coexist.
-- The clone route no longer needs the DELETE preamble.

DROP INDEX IF EXISTS idx_neon_tasks_active_unique;

CREATE UNIQUE INDEX idx_neon_tasks_active_unique_non_clone
  ON neon_tasks (app_id, task_type)
  WHERE status IN ('pending', 'processing') AND task_type <> 'clone';
