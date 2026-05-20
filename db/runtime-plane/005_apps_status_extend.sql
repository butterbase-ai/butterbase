-- @scope: runtime
-- Phase 5: extend apps.provisioning_status to accept move-app values.
-- 'migrating' = SOURCE side, writes blocked, reads allowed.
-- 'migration_target_reserved' = DEST side, before flip; not yet routable.

ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_provisioning_status_check;
ALTER TABLE apps ADD CONSTRAINT apps_provisioning_status_check
  CHECK (provisioning_status IN (
    'provisioning', 'ready', 'deleting', 'failed',
    'migrating', 'migration_target_reserved'
  ));

COMMENT ON COLUMN apps.provisioning_status IS
  'Lifecycle of the app row. ''migrating'' means a move-app saga is mid-flight on the source side: writes are blocked at the gateway layer, reads still served locally until flip.';
