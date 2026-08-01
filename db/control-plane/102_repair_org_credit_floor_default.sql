-- @scope: platform
-- 102: PRE-DEPLOY REPAIR. Restore the safe intermediate state of
-- organizations.credit_floor_usd: DEFAULT 0, and no NULL rows.
--
-- ORDERING: 098 → 099 → 100 → 101 (no-op) → **102** → DEPLOY code → 103 → 104.
-- This file is the LAST migration that may be applied before the code deploy,
-- and it must be applied before it.
--
-- WHY THIS FILE EXISTS. Some environments (local dev, possibly staging/prod)
-- already applied the ORIGINAL, unsplit 098, which dropped the column's
-- DEFAULT and nulled out every row. Those environments are sitting in the
-- post-deploy shape while the OLD code may still be live — i.e. in the exact
-- NaN bypass this whole split exists to prevent: the old build reads the
-- column as `parseFloat(row.credit_floor_usd)`, NULL becomes NaN,
-- `balance < NaN` is always false, and every AI request is admitted
-- regardless of balance, with no error and no log signal.
--
-- Editing 098 cannot fix them. `_migrations` is keyed on FILENAME and the
-- runner skips already-recorded filenames, so a rewritten 098 never runs
-- again; and even if it did, `ADD COLUMN IF NOT EXISTS ... DEFAULT 0` skips
-- the statement entirely when the column exists — it does NOT re-attach the
-- default. The repair therefore has to be a filename no environment has
-- recorded. That is this file.
--
-- Correct on a fresh DB too: 098 already leaves DEFAULT 0 and no NULLs there,
-- so both statements below are no-ops.
--
-- This is also the ROLLBACK REPAIR. If you have already applied 103/104 and
-- need to roll the code back to a build that reads the column without
-- COALESCE, run these two statements FIRST (see 104's header).
--
-- Idempotent: SET DEFAULT is unconditional and converges; the UPDATE is scoped
-- to IS NULL, so a second run touches 0 rows.
--
-- Locks: `SET DEFAULT` is a catalog-only ALTER — it takes ACCESS EXCLUSIVE
-- (which blocks reads) but does not scan or rewrite the table, so the window
-- is sub-millisecond. The UPDATE takes only ROW EXCLUSIVE and does not block
-- readers. They are in one file deliberately: leaving a gap between them would
-- leave newly-inserted orgs at NULL, which is the bug.

ALTER TABLE organizations
  ALTER COLUMN credit_floor_usd SET DEFAULT 0;

-- Every NULL, not just the ones 098 created: while old code is live, ANY NULL
-- in this column is a silently-disabled credit floor.
UPDATE organizations SET credit_floor_usd = 0 WHERE credit_floor_usd IS NULL;
