-- @scope: platform
-- Fix remaining FK actions blocking platform_users deletion.
--
-- Migration 051 fixed hackathon_participants.user_id, but two other tables
-- still have NOT NULL FKs to platform_users(id) with no ON DELETE clause
-- (defaults to NO ACTION). Account deletion (DELETE /dashboard/account in
-- billing.ts) fails for any user with a hackathon submission or score:
--   23503 update or delete on table "platform_users" violates foreign key
--   constraint on hackathon_submissions / hackathon_scores
--
-- Switch both to ON DELETE CASCADE, matching the participants fix.
--
-- Idempotent: drops by constraint name and recreates.

ALTER TABLE hackathon_submissions
    DROP CONSTRAINT IF EXISTS hackathon_submissions_user_id_fkey;

ALTER TABLE hackathon_submissions
    ADD CONSTRAINT hackathon_submissions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES platform_users(id) ON DELETE CASCADE;

ALTER TABLE hackathon_scores
    DROP CONSTRAINT IF EXISTS hackathon_scores_user_id_fkey;

ALTER TABLE hackathon_scores
    ADD CONSTRAINT hackathon_scores_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES platform_users(id) ON DELETE CASCADE;
