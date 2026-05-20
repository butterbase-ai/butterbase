-- @scope: platform
-- 045_hackathon_codes.sql
-- Add hashed submission/judge codes; restructure hackathon_participants for
-- self-registration via MCP (drop email-backfill flow).

-- ---------------------------------------------------------------------------
-- 1. Add code columns to hackathons. Both hashes are required.
--    For any pre-existing rows (none in production yet but the migration must
--    be safe), generate placeholder hashes the admin must rotate immediately.
ALTER TABLE hackathons
    ADD COLUMN submission_code_hash    TEXT,
    ADD COLUMN submission_code_set_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN judge_code_hash         TEXT,
    ADD COLUMN judge_code_set_at       TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill any existing rows with placeholder hashes (admin must rotate).
UPDATE hackathons
   SET submission_code_hash = 'MIGRATION_PLACEHOLDER_ROTATE_REQUIRED',
       judge_code_hash      = 'MIGRATION_PLACEHOLDER_ROTATE_REQUIRED'
 WHERE submission_code_hash IS NULL OR judge_code_hash IS NULL;

ALTER TABLE hackathons
    ALTER COLUMN submission_code_hash SET NOT NULL,
    ALTER COLUMN judge_code_hash      SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. hackathon_participants: drop email-backfill machinery.
--    user_id becomes the lookup key; email becomes nullable & unused.

-- Drop legacy unique constraint and matched_at.
ALTER TABLE hackathon_participants
    DROP CONSTRAINT IF EXISTS hackathon_participants_hackathon_id_email_key;

ALTER TABLE hackathon_participants
    DROP COLUMN IF EXISTS matched_at;

ALTER TABLE hackathon_participants
    ALTER COLUMN email DROP NOT NULL;

-- Replace status check with the smaller domain.
-- First, drop the constraint that enforces the old status values.
ALTER TABLE hackathon_participants
    DROP CONSTRAINT hackathon_participants_status_check;

-- Migrate any existing pending/matched rows to active.
UPDATE hackathon_participants
   SET status = 'active'
 WHERE status IN ('pending','matched');

-- Now add the new constraint that enforces the smaller set of valid statuses.
ALTER TABLE hackathon_participants
    ADD CONSTRAINT hackathon_participants_status_check
        CHECK (status IN ('active','revoked'));

-- Replace source check with expanded domain (legacy values still allowed for
-- historical rows; new rows use 'mcp_self_register').
ALTER TABLE hackathon_participants
    DROP CONSTRAINT IF EXISTS hackathon_participants_source_check;
ALTER TABLE hackathon_participants
    ADD  CONSTRAINT hackathon_participants_source_check
         CHECK (source IN ('mcp_self_register','admin_panel','api','csv_import'));

-- Backfill user_id NULLs only by deletion (no email-match path remains).
DELETE FROM hackathon_participants WHERE user_id IS NULL;

ALTER TABLE hackathon_participants
    ALTER COLUMN user_id SET NOT NULL;

-- New uniqueness invariant: one participant row per (hackathon, user).
ALTER TABLE hackathon_participants
    ADD CONSTRAINT hackathon_participants_hackathon_user_unique
        UNIQUE (hackathon_id, user_id);
