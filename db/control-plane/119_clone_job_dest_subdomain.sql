-- @scope: platform
-- 119: carry the request-time-allocated staging subdomain onto the clone job.
--
-- POST /v1/apps/:id/staging computed a staging subdomain via
-- allocateStagingSubdomain, returned it to the caller as `staging_subdomain`,
-- and then threw it away. The clone worker independently derived its OWN
-- subdomain from the destination app NAME with a random numeric suffix on
-- collision, checked against a DIFFERENT table (org_app_index) from the one
-- the request-time allocator checked (a regional apps.subdomain). The two
-- therefore disagreed by construction, and the API told the caller a subdomain
-- their app did not have.
--
-- The response is sent before the worker runs, so the only way that response
-- can be true is if the value it names is the value actually applied. This
-- column is how it gets there: nullable, written only by start-staging.ts, and
-- read only by the staging_create branch of the clone worker. Every other mode
-- leaves it NULL and keeps the worker's existing derive-from-name behaviour
-- byte-identical.
--
-- Not reconstructible from anything else on the row: dest_app_name is the app
-- NAME (which is not a global namespace and is not DNS-normalised), and the
-- app row does not exist yet at the time the value has to be recorded.
--
-- NUMBER: 118_staging_data_copy.sql is the highest file in either stream
-- (OSS) / 114_template_clone_intents_audit_index.sql (cloud). 119 is free in
-- both. Note the warning in 112: `isAlreadyApplied` matches on FILENAME, so a
-- number colliding across the two streams is silently skipped rather than
-- erroring. Re-verified before picking this one.

ALTER TABLE template_clone_jobs
  ADD COLUMN IF NOT EXISTS dest_subdomain TEXT;

COMMENT ON COLUMN template_clone_jobs.dest_subdomain IS
  'Staging only: the subdomain allocated at request time by '
  'allocateStagingSubdomain and reported to the caller in the POST '
  '/v1/apps/:id/staging response. The clone worker applies this value verbatim '
  'for mode=staging_create instead of deriving its own, so the API''s answer is '
  'the one that lands. If it has been taken by the time the worker runs, the '
  'worker re-allocates through the SAME allocator, appends a job warning naming '
  'both values, and updates this column to the value actually applied - so this '
  'column is always the truth about what the app got. NULL for every other mode.';
