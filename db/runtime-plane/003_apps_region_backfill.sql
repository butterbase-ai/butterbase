-- @scope: runtime
-- Phase 4: replace the default 'local' region with the actual runtime-DB region.
-- The runner sets butterbase.region before applying. The default on the column
-- is left in place so a fresh dev DB still works out of the box.

DO $$
DECLARE
  target_region text := current_setting('butterbase.region', true);
BEGIN
  IF target_region IS NULL OR target_region = '' THEN
    RAISE EXCEPTION 'butterbase.region GUC is not set; the runner must export it before applying';
  END IF;

  UPDATE apps SET region = target_region WHERE region = 'local';
  EXECUTE 'ALTER TABLE apps ALTER COLUMN region DROP DEFAULT';
  EXECUTE format('ALTER TABLE apps ALTER COLUMN region SET DEFAULT %L', target_region);
END $$;

COMMENT ON COLUMN apps.region IS
  'Phase 4: hard region pin. Set by provisioner from the receiving Fly machine. Changed only by move-app saga.';
