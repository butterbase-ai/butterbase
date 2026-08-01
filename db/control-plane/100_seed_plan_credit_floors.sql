-- @scope: platform
-- 100: Seed per-tier credit floor defaults on plans.
--
-- Split from 098 on purpose: 098 owns the *schema* change (adding the column,
-- making organizations.credit_floor_usd nullable-with-inheritance) — a change
-- whose correctness is about locking/nullability/idempotence and is reviewed
-- and re-run for those properties. These four numbers are a *business*
-- decision about how much credit each tier extends, will be revisited on its
-- own schedule (pricing changes, new tiers) independent of the schema, and
-- should not require touching the trap-laden 098 file to change. Keeping them
-- in their own migration also makes the value history greppable by filename
-- instead of buried in a schema-change diff.
--
-- Idempotent: plain UPDATEs, safe to re-run.
--
-- PRE-deploy, safe: old code never reads plans, so these values are inert
-- until the new code (and the post-deploy migrations 103/104) are live.
--
-- playground stays at 0 explicitly (rather than relying on the column
-- DEFAULT) so the full tier table is visible in one place and a future change
-- to the DEFAULT can't silently change the free tier's behaviour.
UPDATE plans SET credit_floor_usd = 0 WHERE id = 'playground';
UPDATE plans SET credit_floor_usd = -10 WHERE id = 'launch';
UPDATE plans SET credit_floor_usd = -25 WHERE id = 'certified';
UPDATE plans SET credit_floor_usd = -50 WHERE id = 'enterprise';
