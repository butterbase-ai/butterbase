-- @scope: platform
-- Add transient staging for env vars supplied at clone-create time and applied
-- during replay, plus a post-replay summary of vars the user still hasn't filled.
-- All three columns are NULL on legacy rows; the worker treats NULL as "no work".

ALTER TABLE template_clone_jobs
  -- TEXT (not JSONB) because the value is opaque AES-256-GCM ciphertext (iv:ct),
  -- not valid JSON. JSONB would reject the INSERT.
  ADD COLUMN IF NOT EXISTS pending_env_vars   TEXT,
  ADD COLUMN IF NOT EXISTS auto_mint_requests JSONB,
  ADD COLUMN IF NOT EXISTS unfilled_env_vars  JSONB;

COMMENT ON COLUMN template_clone_jobs.pending_env_vars IS
  'AES-256-GCM-encrypted JSON: {[fn_name]: {[key]: value}}. Encrypted under AUTH_ENCRYPTION_KEY. Drained + cleared by replayFunctions.';
COMMENT ON COLUMN template_clone_jobs.auto_mint_requests IS
  'JSON array of {fn_name, key} entries to auto-mint a bb_sk_* into. Cleared by replayFunctions.';
COMMENT ON COLUMN template_clone_jobs.unfilled_env_vars IS
  'JSON: {[fn_name]: [key1, key2]}. Written by replayFunctions after applying values. Surface to UI.';
