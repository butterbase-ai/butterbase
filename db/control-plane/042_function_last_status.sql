-- @scope: platform
-- 042_function_last_status.sql
-- Track the HTTP status of the most recent invocation per function so that
-- list_functions can surface a `lastStatus` field. Without this, a function
-- failing on every invocation can still appear healthy when its 24h window
-- contains no traffic.

ALTER TABLE app_functions ADD COLUMN last_status_code INT;

-- Backfill from function_invocations.
--
-- Pre-this-migration, error_count was incremented only when the worker threw
-- or timed out; HTTP error responses (e.g. handler returning `new Response(...,
-- { status: 500 })`) were silently classified as success. As a result,
-- error_count is undercounted for any function that catches its own errors.
-- We rebuild error_count from per-row invocation logs, and seed last_status_code
-- with the most recent invocation's status.
--
-- function_invocations is retained for ~7 days, so functions with no recent
-- traffic will have error_count reset to 0. That is acceptable: the user-facing
-- errorRate is computed from the same 24h window of function_invocations, so
-- the lifetime error_count is no longer load-bearing for monitoring.
UPDATE app_functions f SET
  error_count = COALESCE(sub.errs, 0),
  last_status_code = sub.last_status
FROM (
  SELECT
    function_id,
    COUNT(*) FILTER (WHERE status_code >= 400) AS errs,
    (array_agg(status_code ORDER BY started_at DESC))[1] AS last_status
  FROM function_invocations
  GROUP BY function_id
) sub
WHERE f.id = sub.function_id;
