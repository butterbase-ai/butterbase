-- 101: Drop organizations.credit_floor_usd's DEFAULT and null out the
-- existing explicit-0 rows so they inherit from plans.credit_floor_usd.
--
-- ============================================================================
-- DO NOT APPLY UNTIL THE NEW CODE IS LIVE (i.e. after the deploy that ships
-- lease-service reading credit_floor_usd via
-- COALESCE(organizations.credit_floor_usd, plans.credit_floor_usd, 0)).
-- ============================================================================
--
-- ORDERING (three-phase, do not collapse): 098 + 100 → deploy code → 101.
-- This file is the POST-deploy half of the split that used to be a single
-- migration 098. Before the new code exists, the OLD build reads
-- organizations.credit_floor_usd directly as `parseFloat(row.credit_floor_usd)`,
-- not through COALESCE. A NULL there becomes NaN, and `balance < NaN` is
-- always false — every AI request is silently admitted regardless of
-- balance, a total, silent credit-control bypass that produces no error and
-- no log signal. Running this migration early — even by one deploy cycle —
-- reproduces that bug for every org whose credit_floor_usd was 0 (i.e. all of
-- them, until an operator sets a real override). Confirm the new code is
-- fully rolled out (not just deployed — actually serving traffic, no old
-- revision still handling requests) before running this file.
--
-- Idempotent / re-runnable: DROP DEFAULT on a column with no default is a
-- no-op, and the UPDATE is scoped to rows still at exactly 0 (an org
-- deliberately overridden to 0 after 098/100 shipped would no longer match
-- and is left alone on a re-run).

ALTER TABLE organizations
  ALTER COLUMN credit_floor_usd DROP DEFAULT;

-- Scoped to = 0 (not a blanket NULL-everything) so a real per-org override of
-- 0 — an org deliberately pinned to "no credit" despite its plan — survives a
-- re-run of this migration instead of being reset to "inherit from plan".
UPDATE organizations SET credit_floor_usd = NULL WHERE credit_floor_usd = 0;
