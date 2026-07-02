-- @scope: runtime
-- Plan 11.1: add organization_id to storage_objects (per-org quotas + billing)
-- and to the two attribution log tables (mcp_tool_call_log, partner_proxy_logs).
-- All three: logical cross-plane reference. Nullable until Plan 11.5.
-- storage_objects.user_id (nullable, app end-user uploader) is unchanged.

ALTER TABLE storage_objects
  ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS storage_objects_organization_id_idx
  ON storage_objects (organization_id) WHERE organization_id IS NOT NULL;
COMMENT ON COLUMN storage_objects.organization_id IS
  'Which org owns this storage object. Derived from apps.organization_id via app_id join at write time. Nullable until Plan 11.5.';

ALTER TABLE mcp_tool_call_log
  ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS mcp_tool_call_log_organization_id_idx
  ON mcp_tool_call_log (organization_id) WHERE organization_id IS NOT NULL;
COMMENT ON COLUMN mcp_tool_call_log.organization_id IS
  'Which org this MCP tool call is attributed to. Nullable until Plan 11.5.';

ALTER TABLE partner_proxy_logs
  ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS partner_proxy_logs_organization_id_idx
  ON partner_proxy_logs (organization_id) WHERE organization_id IS NOT NULL;
COMMENT ON COLUMN partner_proxy_logs.organization_id IS
  'Which org this partner API proxy call belongs to. Nullable until Plan 11.5.';
