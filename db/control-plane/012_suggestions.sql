-- @scope: platform
-- MCP tool call log for context capture on suggestions
-- Rows older than 30 days can be safely pruned; no auto-cleanup in v1.
CREATE TABLE IF NOT EXISTS mcp_tool_call_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
    tool_name TEXT NOT NULL,
    parameters JSONB DEFAULT '{}',
    app_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mcp_tool_call_log_api_key_time
  ON mcp_tool_call_log (api_key_id, created_at DESC);

CREATE INDEX idx_mcp_tool_call_log_user_time
  ON mcp_tool_call_log (user_id, created_at DESC);

-- Agent / human-submitted platform feedback
CREATE TABLE IF NOT EXISTS suggestions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category TEXT NOT NULL CHECK (category IN ('bug_report', 'feature_request', 'improvement', 'documentation')),
    severity TEXT CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    description TEXT NOT NULL,
    affected_tool TEXT,
    proposed_solution TEXT,
    context JSONB DEFAULT '{}',
    source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'human_prompted')),
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
    app_id TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'in_progress', 'implemented', 'wont_fix')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_suggestions_status ON suggestions(status);
CREATE INDEX idx_suggestions_category ON suggestions(category);
CREATE INDEX idx_suggestions_affected_tool ON suggestions(affected_tool) WHERE affected_tool IS NOT NULL;
CREATE INDEX idx_suggestions_created_at ON suggestions(created_at DESC);
