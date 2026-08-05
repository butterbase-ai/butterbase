-- Operator agent: per-org autonomous turns.

ALTER TABLE dashboard_agent_conversations
  ADD COLUMN IF NOT EXISTS organization_id TEXT;

CREATE INDEX IF NOT EXISTS dashboard_agent_conversations_org_idx
  ON dashboard_agent_conversations (organization_id, last_message_at DESC NULLS LAST)
  WHERE organization_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_agent_conversations_operator_uniq
  ON dashboard_agent_conversations (organization_id, user_id)
  WHERE organization_id IS NOT NULL;

-- Named recurring jobs. v1 seeds exactly one per org.
CREATE TABLE IF NOT EXISTS dashboard_agent_operator_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  name            TEXT NOT NULL,
  instructions    TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  interval_seconds INTEGER NOT NULL DEFAULT 600,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE INDEX IF NOT EXISTS dashboard_agent_operator_jobs_due_idx
  ON dashboard_agent_operator_jobs (next_run_at)
  WHERE enabled = TRUE;

-- Org-bound service key, AES-256-GCM at rest.
CREATE TABLE IF NOT EXISTS dashboard_agent_operator_credentials (
  organization_id TEXT PRIMARY KEY,
  ciphertext      TEXT NOT NULL,
  iv              TEXT NOT NULL,
  auth_tag        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency ledger: one approved tool execution per approval_id.
CREATE TABLE IF NOT EXISTS dashboard_agent_tool_executions (
  approval_id  UUID PRIMARY KEY
    REFERENCES dashboard_agent_approvals(id) ON DELETE CASCADE,
  result       JSONB NOT NULL,
  executed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
