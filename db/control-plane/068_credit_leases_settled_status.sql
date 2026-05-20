-- @scope: platform
-- 068: Add 'settled' to credit_leases.status CHECK constraint.
--
-- Plan A migration 066 added the `settled_amount_usd` + `settled_at` columns
-- but the status CHECK was inherited from the original topup_leases definition
-- (063_topup_leases.sql) and only allows ('active', 'expired', 'reclaimed', 'returned').
-- settleLease() writes status='settled' and would fail the constraint in prod.
-- Tests didn't catch it because Plan A's DB-backed settle tests were gated as
-- env-gap and applied a local fix; this codifies the constraint update so the
-- migration history is correct.

BEGIN;

ALTER TABLE credit_leases DROP CONSTRAINT IF EXISTS topup_leases_status_check;
ALTER TABLE credit_leases DROP CONSTRAINT IF EXISTS credit_leases_status_check;
ALTER TABLE credit_leases ADD CONSTRAINT credit_leases_status_check
  CHECK (status IN ('active', 'expired', 'reclaimed', 'returned', 'settled'));

COMMIT;
