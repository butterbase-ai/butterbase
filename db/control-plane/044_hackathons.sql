-- @scope: platform
-- 044_hackathons.sql
-- Hackathon submissions: per-hackathon JSONB field schema, participant gating,
-- one submission per (hackathon, participant) with version-on-rewrite.
-- Drives the participant-gated MCP tool and the public submissions dashboard.

CREATE EXTENSION IF NOT EXISTS citext;

-- One row per hackathon. field_schema describes the submission contract used by
-- both the MCP tool (validation) and the public dashboard (rendering + exports).
CREATE TABLE IF NOT EXISTS hackathons (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                TEXT UNIQUE NOT NULL,
    name                TEXT NOT NULL,
    starts_at           TIMESTAMPTZ NOT NULL,
    ends_at             TIMESTAMPTZ NOT NULL,
    submission_deadline TIMESTAMPTZ NOT NULL,
    field_schema        JSONB NOT NULL,
    is_active           BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at >= starts_at),
    CHECK (submission_deadline >= starts_at)
);

-- At most one active hackathon at a time
CREATE UNIQUE INDEX hackathons_only_one_active
    ON hackathons ((is_active)) WHERE is_active;

CREATE INDEX idx_hackathons_active ON hackathons (is_active) WHERE is_active;

-- Participants. Email is the source of truth; user_id is backfilled on first
-- match by an authenticated MCP request.
CREATE TABLE IF NOT EXISTS hackathon_participants (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hackathon_id UUID NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
    email        CITEXT NOT NULL,
    user_id      UUID REFERENCES platform_users(id) ON DELETE SET NULL,
    added_by     UUID REFERENCES platform_users(id) ON DELETE SET NULL,
    source       TEXT NOT NULL CHECK (source IN ('admin_panel','api','csv_import')),
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','matched','revoked')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    matched_at   TIMESTAMPTZ,
    UNIQUE (hackathon_id, email)
);

CREATE INDEX idx_hp_user ON hackathon_participants (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_hp_hackathon_status ON hackathon_participants (hackathon_id, status);

-- Submissions: one per (hackathon, participant); upsert bumps version.
CREATE TABLE IF NOT EXISTS hackathon_submissions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hackathon_id   UUID NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
    participant_id UUID NOT NULL REFERENCES hackathon_participants(id) ON DELETE CASCADE,
    user_id        UUID NOT NULL REFERENCES platform_users(id),
    data           JSONB NOT NULL,
    version        INTEGER NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (hackathon_id, participant_id)
);

CREATE INDEX idx_hs_hackathon_updated ON hackathon_submissions (hackathon_id, updated_at DESC);

-- Trigger functions emit NOTIFY for cache invalidation and SSE delivery.
CREATE OR REPLACE FUNCTION notify_hackathon_participants_changed()
RETURNS TRIGGER AS $$
DECLARE
    payload JSON;
BEGIN
    payload = json_build_object(
        'hackathon_id', COALESCE(NEW.hackathon_id, OLD.hackathon_id),
        'user_id',      COALESCE(NEW.user_id, OLD.user_id),
        'email',        COALESCE(NEW.email::text, OLD.email::text),
        'op',           TG_OP
    );
    PERFORM pg_notify('hackathon_participants_changed', payload::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_hp_notify
AFTER INSERT OR UPDATE OR DELETE ON hackathon_participants
FOR EACH ROW EXECUTE FUNCTION notify_hackathon_participants_changed();

CREATE OR REPLACE FUNCTION notify_hackathon_active_changed()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT' AND NEW.is_active)
        OR (TG_OP = 'UPDATE' AND NEW.is_active IS DISTINCT FROM OLD.is_active) THEN
        PERFORM pg_notify('hackathon_active_changed',
            json_build_object('hackathon_id', NEW.id, 'is_active', NEW.is_active)::text);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_h_active_notify
AFTER INSERT OR UPDATE OF is_active ON hackathons
FOR EACH ROW EXECUTE FUNCTION notify_hackathon_active_changed();

CREATE OR REPLACE FUNCTION notify_hackathon_submission_changed()
RETURNS TRIGGER AS $$
DECLARE
    payload JSON;
BEGIN
    payload = json_build_object(
        'hackathon_id',   COALESCE(NEW.hackathon_id, OLD.hackathon_id),
        'submission_id',  COALESCE(NEW.id, OLD.id),
        'op',             TG_OP
    );
    PERFORM pg_notify('hackathon_submission_changed', payload::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_hs_notify
AFTER INSERT OR UPDATE OR DELETE ON hackathon_submissions
FOR EACH ROW EXECUTE FUNCTION notify_hackathon_submission_changed();
