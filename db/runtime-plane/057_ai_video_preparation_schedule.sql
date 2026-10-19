-- @scope: runtime
-- New lifecycle only; legacy video jobs and their sweeper are unchanged.
BEGIN;
ALTER TABLE ai_video_preparations ADD COLUMN next_action_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE ai_video_preparations ADD COLUMN reference_progress jsonb NOT NULL DEFAULT '{}';
ALTER TABLE ai_video_attempts ADD COLUMN next_action_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX ai_video_preparations_due ON ai_video_preparations(next_action_at) WHERE archived_after_move IS NULL AND status IN ('pending','in_progress');
CREATE INDEX ai_video_attempts_due ON ai_video_attempts(next_action_at) WHERE archived_after_move IS NULL AND submission_state IN ('accepted','submitting','uncertain');
COMMIT;
