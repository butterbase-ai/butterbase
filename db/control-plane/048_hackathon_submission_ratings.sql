-- @scope: platform
-- 048: Shared judge rating per hackathon submission.
-- One row per submission. Last write wins (no per-judge tracking, no audit).
-- 0..5 integer; default 0 means "unrated".

CREATE TABLE IF NOT EXISTS hackathon_submission_ratings (
    submission_id  UUID PRIMARY KEY REFERENCES hackathon_submissions(id) ON DELETE CASCADE,
    rating         SMALLINT NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reuse the existing hackathon_submission_changed channel so any judge browser
-- already subscribed to SSE picks up rating changes without a new pipeline.
CREATE OR REPLACE FUNCTION notify_hackathon_submission_rating_changed()
RETURNS TRIGGER AS $$
DECLARE
    h_id UUID;
    sub_id UUID;
BEGIN
    sub_id := COALESCE(NEW.submission_id, OLD.submission_id);
    SELECT hackathon_id INTO h_id FROM hackathon_submissions WHERE id = sub_id;
    IF h_id IS NOT NULL THEN
      PERFORM pg_notify('hackathon_submission_changed', json_build_object(
        'hackathon_id',  h_id,
        'submission_id', sub_id,
        'op',            'UPDATE'
      )::text);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_hsr_notify
AFTER INSERT OR UPDATE OR DELETE ON hackathon_submission_ratings
FOR EACH ROW EXECUTE FUNCTION notify_hackathon_submission_rating_changed();
