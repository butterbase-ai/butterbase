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
-- new AI calls are refused. Resolution is COALESCE(organizations.credit_floor_usd,
-- plans.credit_floor_usd, 0) — the org column is a per-org OVERRIDE, NULL means
-- "inherit the plan's tier default". plans.credit_floor_usd carries the tier
-- default and is NOT NULL (every plan has one; 0 is the safe/no-credit value).
--
-- 'abandoned': a lease whose TTL elapsed without settling. Distinct from
-- 'reclaimed' because it is NOT refunded — a nominal reservation has nothing
-- worth refunding, and the job may still settle later and must still bill.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS credit_floor_usd NUMERIC(10,4) NOT NULL DEFAULT 0;

COMMENT ON COLUMN plans.credit_floor_usd IS
  'Tier default for how far below zero an org on this plan may go before new AI calls are refused. Zero or negative. Overridden per-org by organizations.credit_floor_usd when that column is non-NULL.';

-- organizations.credit_floor_usd is NULLABLE on purpose: NULL means "inherit
-- from plans.credit_floor_usd", a non-NULL value is a per-org override. It must
-- NOT carry a DEFAULT — a default of 0 would re-pin every newly created org to
-- 0 as an explicit override, defeating plan inheritance the moment the row is
-- inserted.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS credit_floor_usd NUMERIC(10,4);

ALTER TABLE organizations
  ALTER COLUMN credit_floor_usd DROP DEFAULT;

ALTER TABLE organizations
  ALTER COLUMN credit_floor_usd DROP NOT NULL;

-- All 171 existing orgs were backfilled to credit_floor_usd = 0 by the
-- NOT NULL DEFAULT 0 this migration originally added. Left as-is, relaxing the
-- NOT NULL turns those zeros into explicit per-org overrides that beat the
-- plan default — every tier would silently stay pinned at 0, the exact bug
-- this change exists to fix. Null them out so they inherit from the plan
-- instead. Scoped to = 0 (not a blanket NULL-everything) so a real future
-- override of 0 — an org deliberately pinned to "no credit" despite its plan
-- — survives a re-run of this migration.
UPDATE organizations SET credit_floor_usd = NULL WHERE credit_floor_usd = 0;

COMMENT ON COLUMN organizations.credit_floor_usd IS
  'Per-org override of the combined-balance floor before new AI calls are refused. NULL inherits plans.credit_floor_usd. Zero or negative when set. Negative values extend credit.';

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
