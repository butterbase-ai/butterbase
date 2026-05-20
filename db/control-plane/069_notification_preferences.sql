-- @scope: platform
-- 069: Notification preferences, snoozes, and one-click action tokens.
--
-- Backs Phase 3 of the function-failure notification overhaul. The
-- failure-notifier (and any future billing-email caller) consults these
-- tables via notification-prefs.service.isSilenced() before handing a
-- message to SES. Empty tables = current behavior (all emails sent).
--
-- Token rows are append-only at write time and `consumed_at`-stamped at
-- redeem time. Cleanup of expired/consumed rows is deferred to a future
-- migration once we have a maintenance cron; the expires_at index keeps
-- that future delete cheap.

BEGIN;

-- Per-user template opt-outs. `unsubscribed_templates` mirrors the
-- BillingEmailTemplate union in email-service.ts. An empty array (default)
-- means subscribed to everything.
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  unsubscribed_templates text[] NOT NULL DEFAULT '{}'::text[],
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Per-(user, scope) snoozes. scope_type is 'template' | 'app' | 'function';
-- scope_id is the template name, app_id, or function_id respectively.
-- A row is considered active iff snoozed_until > now(). Past rows are
-- harmless to keep around for a while (audit / debug) and pruned later.
CREATE TABLE IF NOT EXISTS notification_snoozes (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('template', 'app', 'function')),
  scope_id text NOT NULL,
  snoozed_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS notification_snoozes_active_idx
  ON notification_snoozes (user_id, snoozed_until);

-- One-shot, expiring action tokens embedded in outbound emails. Each row
-- encodes a single intent (snooze 24h, mute a function, unsubscribe a
-- template) that the recipient triggers by clicking a tokenized link.
-- `payload` carries the parameters the action needs (template name,
-- function_id, etc.). consumed_at = NULL means unused.
CREATE TABLE IF NOT EXISTS notification_action_tokens (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('snooze_function_24h', 'mute_function', 'unsubscribe_template')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS notification_action_tokens_expires_idx
  ON notification_action_tokens (expires_at)
  WHERE consumed_at IS NULL;

COMMIT;
