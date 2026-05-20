-- @scope: platform
-- Migration: Add Cognito authentication columns to platform_users
-- This migration adds support for Cognito OAuth authentication
-- Idempotent: safe if partially applied or drifted from _migrations state

-- Add cognito_sub column (unique identifier from Cognito)
ALTER TABLE platform_users
ADD COLUMN IF NOT EXISTS cognito_sub TEXT;

-- Unique constraint (skip if already present)
DO $$
BEGIN
  ALTER TABLE platform_users ADD CONSTRAINT platform_users_cognito_sub_key UNIQUE (cognito_sub);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Add email_verified column
ALTER TABLE platform_users
ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;

-- Make password_hash nullable (since Cognito users don't have passwords)
ALTER TABLE platform_users
ALTER COLUMN password_hash DROP NOT NULL;

-- Index for faster lookups (separate from UNIQUE index when present)
CREATE INDEX IF NOT EXISTS idx_platform_users_cognito_sub ON platform_users(cognito_sub);

-- Update existing users to have email_verified = true
UPDATE platform_users SET email_verified = true WHERE email_verified IS NULL;
