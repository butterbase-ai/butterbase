-- @scope: platform
-- Review metadata is immutable after proposal creation. Attempt reporting is
-- separate; neither field replaces the exact approved operation.
ALTER TABLE dashboard_agent_approvals
  ADD COLUMN IF NOT EXISTS proposal_details JSONB,
  ADD COLUMN IF NOT EXISTS execution_outcome JSONB;

CREATE INDEX IF NOT EXISTS idx_approvals_pending_proposal_intent
  ON dashboard_agent_approvals ((proposal_details->>'intentFingerprint'))
  WHERE status = 'pending' AND proposal_details IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_approvals_pending_proposal_operation
  ON dashboard_agent_approvals ((proposal_details->>'operationFingerprint'))
  WHERE status = 'pending' AND proposal_details IS NOT NULL;
