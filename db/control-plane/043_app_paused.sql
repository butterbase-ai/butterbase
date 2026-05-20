-- @scope: platform
-- 043_app_paused.sql
-- App-level kill-switch. When paused = true, data-plane traffic (auto-API, storage,
-- realtime, function invocations, cron triggers) is short-circuited with a 503.
-- Control-plane endpoints (config, list_apps, the pause toggle itself) keep working
-- so the operator can inspect and resume the app.

ALTER TABLE apps ADD COLUMN paused BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE apps ADD COLUMN paused_at TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN paused_reason TEXT;
