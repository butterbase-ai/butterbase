-- @scope: runtime
-- Adds app_user_id to function_invocations to attribute end-user function calls
-- for the admin activity dashboard. Distinct from user_id, which is populated for
-- both end-user JWT calls AND service-key impersonation (X-Butterbase-As-User).
-- app_user_id is only set when callerType === 'end_user_jwt', so it unambiguously
-- represents a real end-user action rather than a backend/service-key operation.

ALTER TABLE function_invocations ADD COLUMN IF NOT EXISTS app_user_id UUID;

-- Partial index: most rows are NULL (service-key calls), so a partial index on
-- non-NULL rows keeps it small and efficient for per-user activity queries.
CREATE INDEX IF NOT EXISTS idx_function_invocations_app_user
  ON function_invocations(app_user_id, started_at DESC)
  WHERE app_user_id IS NOT NULL;
