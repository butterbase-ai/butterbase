-- 098: Reserve-small credit holds.
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

ALTER TABLE credit_leases
  DROP CONSTRAINT IF EXISTS credit_leases_status_check;

ALTER TABLE credit_leases
  ADD CONSTRAINT credit_leases_status_check
  CHECK (status = ANY (ARRAY[
    'active'::text, 'expired'::text, 'reclaimed'::text,
    'returned'::text, 'settled'::text, 'abandoned'::text
  ]));

-- Sweeper/alert query: unsettled leases past expiry.
CREATE INDEX IF NOT EXISTS credit_leases_abandoned_idx
  ON credit_leases (expires_at) WHERE status = 'abandoned';
