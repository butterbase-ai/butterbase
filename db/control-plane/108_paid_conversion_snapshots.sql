-- @scope: platform
-- Daily snapshot of the paid-conversion metric.
--
-- Subscription rows carry created_at/updated_at but no status history, so a
-- past conversion rate cannot be reconstructed after the fact. Without this
-- table the Overview card can only ever answer "what is it right now".
-- One row per day, written by the nightly billing task.

CREATE TABLE IF NOT EXISTS paid_conversion_snapshots (
    snapshot_date       DATE PRIMARY KEY,

    -- Strict: active paid subscription with no scheduled cancellation.
    paying_users        INTEGER NOT NULL,
    paying_orgs         INTEGER NOT NULL,

    -- Broad: additionally counts past_due (dunning).
    broad_paying_users  INTEGER NOT NULL,
    broad_paying_orgs   INTEGER NOT NULL,

    -- Denominators, internal/staff/seed accounts already excluded.
    eligible_users      INTEGER NOT NULL,
    eligible_orgs       INTEGER NOT NULL,

    captured_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE paid_conversion_snapshots IS
  'Daily paid-conversion history. Written by the nightly billing task; see services/control-api/src/services/paid-conversion.ts for the metric definition.';
