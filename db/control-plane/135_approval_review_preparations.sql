-- @scope: platform
-- A preparation request never grants permission to execute its operation.
CREATE TABLE IF NOT EXISTS dashboard_agent_review_preparations (
  approval_id UUID PRIMARY KEY REFERENCES dashboard_agent_approvals(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  conversation_id UUID NOT NULL REFERENCES dashboard_agent_conversations(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  operation JSONB NOT NULL,
  intent_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','running','replaced','blocked','failed')),
  replacement_approval_id UUID REFERENCES dashboard_agent_approvals(id) ON DELETE SET NULL,
  safe_error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claim_token UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_review_preparations_work ON dashboard_agent_review_preparations(organization_id,state,created_at);
