-- @scope: platform
-- 081: Backfill platform_users.plan_id so the signup-grant path never sees NULL.
--
-- Context: the column default is 'playground', but historically a small window
-- existed where a newly-inserted platform_users row could be observed with a
-- NULL plan_id before provisionStripeCustomer assigned it. The JIT signup-grant
-- IIFE in auth.ts re-SELECTed plan_id and fell back to 'free' (a plan that
-- does not exist), silently no-op'ing the grant.
--
-- This migration is defensive: in current prod plan_id has a DB default of
-- 'playground' applied at INSERT time, so no rows are expected to be NULL.
-- The UPDATE is idempotent and safe to re-run.

BEGIN;

UPDATE platform_users
SET plan_id = 'playground'
WHERE plan_id IS NULL;

COMMIT;
