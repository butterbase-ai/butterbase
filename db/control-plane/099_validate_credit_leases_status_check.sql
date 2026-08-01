-- @scope: platform
-- 099: Validate the credit_leases status CHECK added NOT VALID in 098.
--
-- Must be a separate FILE, not just a separate statement: the migration runner
-- wraps each file in one transaction, and 098 already holds ACCESS EXCLUSIVE on
-- credit_leases from the ADD CONSTRAINT. Validating inside that transaction
-- would run the full scan under ACCESS EXCLUSIVE and block every grant and
-- settle — exactly what splitting the DDL was meant to avoid. In its own
-- transaction, VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE: the scan
-- runs concurrently with reads and writes.
--
-- The scan cannot fail. The value list added in 098 is a strict superset of the
-- constraint it replaced (it only adds 'abandoned'), so no pre-existing row can
-- violate it.
--
-- Idempotent: VALIDATE CONSTRAINT on an already-validated constraint is a no-op.

ALTER TABLE credit_leases
  VALIDATE CONSTRAINT credit_leases_status_check;
