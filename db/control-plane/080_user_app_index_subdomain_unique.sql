-- @scope: platform
-- 080_user_app_index_subdomain_unique.sql
-- Subdomains are a global namespace (every app gets <subdomain>.butterbase.app).
-- Pre-cutover the uniqueness check happened per-region against the runtime
-- apps table, which doesn't protect against cross-region collisions. This
-- migration adds the DB-level guarantee at the only cross-region table we
-- already have: user_app_index.
--
-- Pre-flight: surface any existing duplicates as a NOTICE before attempting
-- the index. If duplicates exist, the CREATE UNIQUE INDEX will fail and an
-- operator must reconcile by suffixing one of the duplicate subdomains.

DO $$
DECLARE
  dup_count INT;
BEGIN
  SELECT COUNT(*)::INT INTO dup_count FROM (
    SELECT subdomain FROM user_app_index
     WHERE subdomain IS NOT NULL
     GROUP BY subdomain HAVING COUNT(*) > 1
  ) AS d;

  IF dup_count > 0 THEN
    RAISE NOTICE 'user_app_index has % subdomains held by more than one app; UNIQUE index creation will fail. Reconcile before re-running.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS user_app_index_subdomain_uniq
  ON user_app_index (subdomain)
  WHERE subdomain IS NOT NULL;

COMMENT ON INDEX user_app_index_subdomain_uniq IS
  'Cross-region subdomain uniqueness. Partial index because legacy rows may have NULL subdomain.';
