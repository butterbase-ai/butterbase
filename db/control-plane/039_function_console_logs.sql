-- @scope: platform
-- Add console_logs column to function_invocations for capturing console.log output
ALTER TABLE function_invocations ADD COLUMN IF NOT EXISTS console_logs JSONB;
