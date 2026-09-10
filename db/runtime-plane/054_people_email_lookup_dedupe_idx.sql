-- @scope: runtime
-- 054_people_email_lookup_dedupe_idx.sql
-- Supports the email-lookup dedupe branch in routes/people.ts, which reuses a
-- recent resolved lookup instead of paying the provider to re-resolve a profile
-- the app already paid for. Without this index that lookup seq-scans
-- people_email_lookups on every queue call.
--
-- Partial on status='resolved' because the dedupe path only ever reads resolved
-- rows; that keeps the index small next to the pending/failed/expired majority.
-- resolved_at DESC matches the query's ORDER BY so the freshness window is a
-- backwards index scan rather than a sort.

CREATE INDEX IF NOT EXISTS idx_people_email_lookups_dedupe
  ON people_email_lookups (app_id, normalized_url, resolved_at DESC)
  WHERE status = 'resolved';
