-- @scope: platform
-- 046: Hackathon scoring system
-- Adds app_id to submissions and creates a scores table for async judging.

ALTER TABLE hackathon_submissions
    ADD COLUMN IF NOT EXISTS app_id TEXT REFERENCES apps(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS hackathon_scores (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id       UUID NOT NULL REFERENCES hackathon_submissions(id) ON DELETE CASCADE,
    hackathon_id        UUID NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
    participant_id      UUID NOT NULL REFERENCES hackathon_participants(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES platform_users(id),

    -- Per-criterion scores
    criterion_demo_url  NUMERIC(5,2) NOT NULL DEFAULT 0,    -- 0 or 50
    criterion_features  NUMERIC(5,2) NOT NULL DEFAULT 0,    -- 0..50
    total_score         NUMERIC(5,2) NOT NULL DEFAULT 0,    -- 0..100

    -- Audit trail
    feature_breakdown   JSONB NOT NULL DEFAULT '{}',        -- per-feature scores
    scored_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (submission_id)
);

CREATE INDEX IF NOT EXISTS idx_hackathon_scores_leaderboard
    ON hackathon_scores (hackathon_id, total_score DESC, scored_at ASC);
