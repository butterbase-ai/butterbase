-- @scope: platform
-- Staging environments become a paid feature, gated the same way custom
-- domains already are: a boolean in plans.features, read through the app's
-- owning organization.
--
-- Merged into the existing JSONB rather than replacing it — these rows already
-- carry custom_domain / priority_support / sso / soc2, and replacing the object
-- would silently drop them.
--
-- Pre-deploy safe: the current image never reads features.staging, so adding
-- the key changes nothing until the new image ships.
UPDATE plans SET features = COALESCE(features, '{}'::jsonb) || '{"staging": true}'::jsonb
 WHERE id IN ('launch', 'certified', 'enterprise');

UPDATE plans SET features = COALESCE(features, '{}'::jsonb) || '{"staging": false}'::jsonb
 WHERE id = 'playground';

-- Any plan added later must state its position explicitly rather than
-- inheriting a silent default.
UPDATE plans SET features = COALESCE(features, '{}'::jsonb) || '{"staging": false}'::jsonb
 WHERE NOT (features ? 'staging');
