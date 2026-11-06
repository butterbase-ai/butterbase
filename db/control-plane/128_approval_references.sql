-- @scope: platform
-- Evidence the turn read before proposing an action. Additive; existing rows
-- default to an empty list and are never backfilled.

ALTER TABLE dashboard_agent_approvals
  ADD COLUMN IF NOT EXISTS "references" JSONB NOT NULL DEFAULT '[]'::jsonb;
