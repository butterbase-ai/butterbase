-- @scope: runtime
-- Workers for Platforms is the default hosting backend. Production sets
-- DEPLOYMENT_DEFAULT_BACKEND=wfp and provisioner.ts always writes the backend
-- explicitly; this column default protects direct inserts and tooling from
-- silently creating Pages-backed apps. Existing rows keep their value.
ALTER TABLE apps ALTER COLUMN deployment_backend SET DEFAULT 'wfp';
