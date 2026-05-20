-- @scope: platform
-- Migration 038: Auth Hooks
-- Add optional post-auth hook function name to apps table.
-- When set, the named Butterbase function is invoked (fire-and-forget)
-- after every successful authentication event (OAuth, login, signup).

ALTER TABLE apps ADD COLUMN IF NOT EXISTS auth_hook_function TEXT;

COMMENT ON COLUMN apps.auth_hook_function IS
  'Name of a deployed Butterbase function to invoke after successful auth events. Fire-and-forget.';
