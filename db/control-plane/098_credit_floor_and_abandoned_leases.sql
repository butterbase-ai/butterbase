-- @scope: platform
-- 098: Reserve-small credit holds.
--
-- ORDERING (three-phase, do not collapse):
--   PRE-deploy:  098 → 099 → 100 → 101 (no-op tombstone) → 102
--   then DEPLOY the COALESCE-reading code and confirm it is serving traffic
--   POST-deploy: 103 → 104
--
-- 102 is the repair migration: it re-establishes this file's safe intermediate
-- state (DEFAULT 0, all rows 0) in any environment that already ran the
-- ORIGINAL, unsplit 098. Rewriting this file in place does NOT reach those
-- environments — `_migrations` is keyed on filename and the runner skips by
-- filename, and `ADD COLUMN IF NOT EXISTS ... DEFAULT 0` does not re-attach a
-- default to a column that already exists. That is why the repair lives in a
-- new file number and not in an edit here.
--
-- This file, 100 and 102 are PRE-deploy and must stay backward compatible with the
-- OLD code that is still running when they are applied — lease-service
-- grantLease SELECTs organizations.credit_floor_usd unconditionally, on BOTH
-- the legacy and the reserve-small path, and the OLD build reads that column
-- with `parseFloat(row.credit_floor_usd)`, not COALESCE. If this file ever
-- produced a NULL there, parseFloat(null) is NaN, and `balance < NaN` is
-- always false — every AI request would be silently admitted regardless of
-- balance, a total credit-control bypass, indistinguishable from "healthy"
-- because nothing errors. That is why organizations.credit_floor_usd KEEPS
-- its DEFAULT 0 here and why the null-out backfill is NOT in this file —
-- the DROP DEFAULT is deferred to 103 and the null-out to 104, neither of
-- which may run until the new COALESCE-reading code is fully live. See 104's
-- header for the rest of the story, including the rollback procedure.
--
-- Also apply before the code deploy: lease-service.grantLease SELECTs
-- organizations.credit_floor_usd unconditionally, so deploying the image
-- before this migration makes every AI request 500 with `column
-- "credit_floor_usd" does not exist`. Apply 098-102, confirm, then deploy.
--
-- ROLLBACK: rolling the CODE back is safe as long as the post-deploy
-- migrations (103, 104) have NOT run — while the column still has DEFAULT 0
-- and every row is an explicit 0, old code reads exactly what it reads today.
-- Once 103/104 have run, rolling the code back WITHOUT first running the
-- repair re-opens the NaN bypass on every org. The exact repair SQL is in
-- 104's header and in the spec's Rollout section; 102 is that same SQL as a
-- migration. Rolling THIS migration back (dropping the column) while the code
-- is live 500s every AI request.
--
-- credit_floor_usd: how far below zero an org's combined balance may go before
-- new AI calls are refused. Once 103/104 have run, resolution is
-- COALESCE(organizations.credit_floor_usd, plans.credit_floor_usd, 0) — the
-- org column is a per-org OVERRIDE, NULL means "inherit the plan's tier
-- default". Until then, every org's credit_floor_usd is an explicit 0,
-- which is both the old behaviour and a value the COALESCE treats as a valid
-- override — inert either way. plans.credit_floor_usd carries the tier
-- default and is NOT NULL (every plan has one; 0 is the safe/no-credit value).
--
-- 'abandoned': a lease whose TTL elapsed without settling. Distinct from
-- 'reclaimed' because it is NOT refunded — a nominal reservation has nothing
-- worth refunding, and the job may still settle later and must still bill.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS credit_floor_usd NUMERIC(10,4) NOT NULL DEFAULT 0;

COMMENT ON COLUMN plans.credit_floor_usd IS
  'Tier default for how far below zero an org on this plan may go before new AI calls are refused. Zero or negative. Overridden per-org by organizations.credit_floor_usd when that column is non-NULL.';

-- organizations.credit_floor_usd is NULLABLE (post-104, NULL will mean
-- "inherit from plans.credit_floor_usd"; a non-NULL value is a per-org
-- override). It DELIBERATELY KEEPS its DEFAULT 0 in this migration — do not
-- drop it here and do not "clean this up" in a later edit of this file.
-- Dropping the default now would let a newly-inserted org get a NULL
-- credit_floor_usd while the OLD code is still live, which the old
-- parseFloat() read turns into NaN — `balance < NaN` is always false, so that
-- org's credit floor is silently disabled. Same bug as the null-out backfill,
-- just via INSERT instead of UPDATE, and just as easy to miss. The DEFAULT is
-- dropped in 103, once the new code (which reads NULL correctly via COALESCE)
-- is fully rolled out.
--
-- NOTE: this ADD COLUMN is a no-op on an environment where the column already
-- exists, INCLUDING its DEFAULT clause — `IF NOT EXISTS` skips the whole
-- statement, it does not reconcile the default. An environment that ran the
-- original unsplit 098 (default dropped, rows nulled) is NOT repaired by
-- re-running this file. Migration 102 does that repair.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS credit_floor_usd NUMERIC(10,4) DEFAULT 0;

ALTER TABLE organizations
  ALTER COLUMN credit_floor_usd DROP NOT NULL;

-- No backfill / null-out UPDATE here on purpose. Existing rows keep their
-- explicit 0 (the same value the DEFAULT would have given them). Old code
-- reads 0 and behaves exactly as today; new code sees 0 as an explicit
-- override that happens to equal the old behaviour — inert either way. The
-- null-out that turns these zeros into "inherit from plan" is deferred to
-- migration 104, which must not run until the new code is live. Running it
-- here would reproduce the exact NaN bypass this split exists to prevent.
COMMENT ON COLUMN organizations.credit_floor_usd IS
  'Per-org override of the combined-balance floor before new AI calls are refused. NULL inherits plans.credit_floor_usd (only meaningful once migration 104 has run and the COALESCE-reading code is live). Zero or negative when set. Negative values extend credit.';

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
