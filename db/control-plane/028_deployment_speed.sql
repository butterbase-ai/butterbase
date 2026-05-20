-- @scope: platform
-- 028_deployment_speed.sql
-- Add cloudflare_project_name to apps table for tracking CF project per app
-- Add max_deployments to plans table for per-plan deployment retention limits

ALTER TABLE apps ADD COLUMN IF NOT EXISTS cloudflare_project_name TEXT;

ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_deployments INTEGER NOT NULL DEFAULT 10;

-- Set per-plan retention limits
UPDATE plans SET max_deployments = 2 WHERE id = 'playground';
UPDATE plans SET max_deployments = 10 WHERE id = 'launch';
UPDATE plans SET max_deployments = 25 WHERE id = 'certified';
UPDATE plans SET max_deployments = -1 WHERE id = 'enterprise';
