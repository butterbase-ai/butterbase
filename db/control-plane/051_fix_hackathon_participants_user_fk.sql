-- @scope: platform
-- Fix conflicting FK action on hackathon_participants.user_id.
--
-- Migration 044 created the column with: REFERENCES platform_users(id) ON DELETE SET NULL.
-- Migration 045 later made the column NOT NULL.
-- When platform_users is deleted (e.g. account-delete flow in billing.ts),
-- the FK tries to SET user_id = NULL, which the NOT NULL constraint refuses,
-- and the whole DELETE rolls back. Symptom: account deletion 500s with
--   23502 null value in column "user_id" of relation "hackathon_participants"
--
-- Switch the FK to ON DELETE CASCADE so user deletion removes their
-- participation rows too (matching the model used for apps, api_keys,
-- subscriptions, etc.).
--
-- Idempotent: drops the existing FK by name and recreates it.

ALTER TABLE hackathon_participants
    DROP CONSTRAINT IF EXISTS hackathon_participants_user_id_fkey;

ALTER TABLE hackathon_participants
    ADD CONSTRAINT hackathon_participants_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES platform_users(id) ON DELETE CASCADE;
