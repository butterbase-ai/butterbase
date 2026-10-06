-- @scope: platform
-- 115: Make the auto-refill trigger point user-configurable, and move the
-- credits-email dedup markers from platform_users onto organizations.
--
-- Two related changes, one migration, because the email path reads both.
--
-- 1. organizations.auto_refill_threshold_usd
--    Until now the trigger was a hardcoded constant in auto-refill-service.ts
--    (`LOW_LEGACY_TOPUP_USD = 5`): with no monthly allowance left, refill fired
--    once top-up credit fell below $5. That number was never surfaced in the
--    UI, so "when does this actually charge me?" had no answer short of
--    reading the source. This column is that constant, per-org.
--
--    NULL means "use the built-in default of 5", deliberately: every existing
--    org keeps today's exact behaviour on deploy, and the column only starts
--    mattering once someone edits it in the dashboard. A NOT NULL DEFAULT 5
--    would look equivalent but is not — it erases the distinction between
--    "never configured" and "deliberately set to 5", which is the thing an
--    admin wants to know when debugging a refill that fired early.
--
--    It does NOT govern the second trigger. `crossedZero` (monthly + topup
--    <= 0) stays unconditional in the service, so an org whose threshold is
--    set to $1 and which takes a single $40 charge from $30 still refills
--    instead of sailing past the trigger into the negative floor.
--
-- 2. organizations.credits_low_emailed_at / credits_exhausted_emailed_at
--    Migration 071 put these on platform_users, before billing was per-org.
--    Migration 093 moved the balances they debounce (monthly_allowance_usd,
--    credits_usd) onto organizations and left these behind, so the low-credit
--    email keyed its "already warned" state to the USER while reading the
--    balance of that user's PERSONAL org. On a team org that is the wrong
--    balance entirely: the org burning credits is not the org being checked,
--    so team orgs were never warned, and a user in three orgs shared one
--    debounce marker across all of them.
--
--    The markers belong next to the balance they debounce. The platform_users
--    columns are intentionally NOT dropped here — same reasoning as migration
--    096 gave for the stale auto_refill_* columns: drop them in a separate
--    migration once a sweep confirms no reader remains. Leaving them costs two
--    dead columns; dropping them early costs an outage if a reader was missed.

BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS auto_refill_threshold_usd    NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS credits_low_emailed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS credits_exhausted_emailed_at TIMESTAMPTZ;

COMMENT ON COLUMN organizations.auto_refill_threshold_usd IS
  'Balance at or below which auto-refill charges the card, in USD. NULL means use the service default of 5. Does not govern the crossedZero trigger, which always fires at a combined balance of zero.';
COMMENT ON COLUMN organizations.credits_low_emailed_at IS
  'Debounce marker for the credits_low email. Cleared whenever the org balance is topped up or the monthly allowance resets.';
COMMENT ON COLUMN organizations.credits_exhausted_emailed_at IS
  'Debounce marker for the credits_exhausted email. Cleared whenever the org balance is topped up or the monthly allowance resets.';

-- Carry the existing per-user markers over to each user's personal org, so
-- deploying this does not re-send a warning to everyone who was already warned.
-- Only personal orgs can be backfilled — team orgs have no prior state to
-- inherit, and start un-warned, which is correct: they were never warned.
UPDATE organizations o
   SET credits_low_emailed_at       = pu.credits_low_emailed_at,
       credits_exhausted_emailed_at = pu.credits_exhausted_emailed_at
  FROM platform_users pu
 WHERE pu.personal_organization_id = o.id
   AND o.credits_low_emailed_at IS NULL
   AND o.credits_exhausted_emailed_at IS NULL
   AND (pu.credits_low_emailed_at IS NOT NULL
     OR pu.credits_exhausted_emailed_at IS NOT NULL);

COMMIT;
