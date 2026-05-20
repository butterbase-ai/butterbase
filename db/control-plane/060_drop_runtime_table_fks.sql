-- @scope: platform
--
-- Phase 2: drop FK constraints from platform-tier tables to apps (which now
-- lives in per-region runtime DBs). The columns themselves remain — they're
-- now logical FKs validated at write time and cleaned up by the
-- cleanup-cross-tier-orphans cron.
--
-- Cross-tier FKs verified via:
--   SELECT conname, conrelid::regclass AS "table", confrelid::regclass AS "references"
--   FROM pg_constraint WHERE contype = 'f'
--   AND conrelid::regclass::text IN ('subscriptions','usage_meters','billing_events','credit_topups','processed_webhook_events')
--   AND confrelid::regclass::text IN ('apps','platform_users');
--
-- Only usage_meters_app_id_fkey references apps; the others are same-tier
-- (platform_users). Dropping with IF EXISTS is safe for idempotency.

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_app_id_fkey;
ALTER TABLE usage_meters DROP CONSTRAINT IF EXISTS usage_meters_app_id_fkey;
ALTER TABLE billing_events DROP CONSTRAINT IF EXISTS billing_events_app_id_fkey;
-- credit_topups has no app_id FK per spec; verified above.
-- processed_webhook_events: standalone, no FK to drop.
