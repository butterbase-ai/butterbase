-- 098: Reserve-small credit holds.
--
-- ORDERING: THIS MIGRATION MUST BE APPLIED STRICTLY BEFORE THE CODE DEPLOY.
-- lease-service.grantLease SELECTs organizations.credit_floor_usd
-- unconditionally, on BOTH the legacy and the reserve-small path — it is not
-- behind AI_RESERVE_SMALL_ENABLED. Deploying the image first makes every AI
-- request 500 with `column "credit_floor_usd" does not exist` until this runs.
-- Apply here, confirm, then deploy. (Rolling back the code is safe; rolling
-- back this migration while the code is live is not.)
--
-- credit_floor_usd: how far below zero an org's combined balance may go before
-- new AI calls are refused. 0 preserves today's behaviour (no credit extended),
-- so this migration is behaviour-neutral until per-tier defaults are set.
--
-- 'abandoned': a lease whose TTL elapsed without settling. Distinct from
-- 'reclaimed' because it is NOT refunded — a nominal reservation has nothing
-- worth refunding, and the job may still settle later and must still bill.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS credit_floor_usd NUMERIC(10,4) NOT NULL DEFAULT 0;

COMMENT ON COLUMN organizations.credit_floor_usd IS
  'Minimum combined (monthly_allowance_usd + credits_usd) balance before new AI calls are refused. Zero or negative. Negative values extend credit.';

-- Added NOT VALID on purpose. A plain ADD CONSTRAINT ... CHECK takes
-- ACCESS EXCLUSIVE on credit_leases and full-scans it to validate, blocking
-- every grant and settle for the duration — on the hot billing table. NOT VALID
-- skips the scan, so the ACCESS EXCLUSIVE window is a catalog write only.
-- Migration 099 then runs VALIDATE CONSTRAINT in its own transaction, which
-- takes only SHARE UPDATE EXCLUSIVE and does not block reads or writes.
--
-- The scan cannot fail: the new value list is a strict superset of the old one
-- (it only adds 'abandoned'), so no existing row can violate it. The constraint
-- is enforced for new and updated rows from the moment it is added, even while
-- NOT VALID.
--
-- Re-runnable: DROP CONSTRAINT IF EXISTS makes re-applying this file a no-op in
-- effect, so an environment that already ran the pre-split version converges to
-- the same end state.
ALTER TABLE credit_leases
  DROP CONSTRAINT IF EXISTS credit_leases_status_check;

ALTER TABLE credit_leases
  ADD CONSTRAINT credit_leases_status_check
  CHECK (status = ANY (ARRAY[
    'active'::text, 'expired'::text, 'reclaimed'::text,
    'returned'::text, 'settled'::text, 'abandoned'::text
  ])) NOT VALID;

-- Sweeper/alert query: unsettled leases past expiry.
CREATE INDEX IF NOT EXISTS credit_leases_abandoned_idx
  ON credit_leases (expires_at) WHERE status = 'abandoned';
