-- @scope: data
-- RLS Helper Functions
-- This migration provides helper functions for Row Level Security

-- Function to get the current user ID from JWT claims
CREATE OR REPLACE FUNCTION current_user_id() RETURNS TEXT AS $$
  SELECT current_setting('request.jwt.claim.sub', true)
$$ LANGUAGE SQL STABLE;

-- Note: This function returns NULL if the setting is not set
-- RLS policies should handle NULL appropriately
