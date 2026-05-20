-- @scope: platform
-- 041_access_mode.sql
-- Add app-level access mode to control anonymous vs authenticated-only data access.
-- 'public' (default): anonymous requests allowed, RLS policies apply if configured.
-- 'authenticated': all data/realtime requests require a valid end-user JWT or API key.

ALTER TABLE apps ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'public';
