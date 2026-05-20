-- @scope: platform
-- AI key tracking and billing
-- Adds fields to track BYOK vs platform key usage for proper billing

-- Add key type tracking to AI usage logs
ALTER TABLE ai_usage_logs ADD COLUMN key_type TEXT DEFAULT 'platform';
ALTER TABLE ai_usage_logs ADD COLUMN charged_to_user BOOLEAN DEFAULT false;

-- Add index for billing queries
CREATE INDEX idx_ai_usage_logs_key_type ON ai_usage_logs(key_type, charged_to_user);
CREATE INDEX idx_ai_usage_logs_billing ON ai_usage_logs(app_id, key_type, charged_to_user, created_at);

-- Add comment for operators about encryption
COMMENT ON COLUMN apps.ai_config IS 'JSONB config. byokKey should be encrypted with AES-256-GCM format (iv:ciphertext:authTag)';
