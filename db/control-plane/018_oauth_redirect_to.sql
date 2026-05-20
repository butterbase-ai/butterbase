-- @scope: platform
-- Migration 018: Add redirect_to to oauth_states
-- Adds support for storing the frontend redirect URL after OAuth authentication

ALTER TABLE oauth_states
ADD COLUMN redirect_to TEXT;

COMMENT ON COLUMN oauth_states.redirect_to IS 'Frontend URL to redirect to after successful OAuth authentication';
