-- @scope: platform
-- Preferences are owned by the existing user/organization rows and disappear
-- with account/org deletion. NULL inherits the deployment's current default.
BEGIN;
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS assistant_model text
  CHECK (assistant_model IS NULL OR (length(assistant_model) BETWEEN 1 AND 200 AND assistant_model=btrim(assistant_model)));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS operator_model text
  CHECK (operator_model IS NULL OR (length(operator_model) BETWEEN 1 AND 200 AND operator_model=btrim(operator_model)));
COMMIT;
