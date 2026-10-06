-- Distributed trace id for autonomous operator turns (Task D1).
--
-- There is no hibernation (Stage C stopped: Alibaba's pause requires an
-- undocumented "snapshot feature" with no public API). The boundary that
-- actually needs a trace id to survive is narrower but real: a gated
-- operator turn pauses on a human approval, the cron-scheduler process that
-- ran it may exit or be replaced (deploys, restarts, region failover) before
-- that approval is resolved, and a LATER wake resumes the same conversation
-- once it is. Persisting the trace id on the approval row is what lets that
-- resumed wake report the same trace id as the turn that gated, instead of
-- starting a new one that cannot be joined back to the original timeline.
--
-- trace_id: nullable — rows created before this migration have none, and
-- there is no meaningful backfill (the original wake's id is gone).
--
-- resumed_at: marks the FIRST wake that consumed this approval's trace id to
-- continue the conversation. Without it, every subsequent wake after the
-- approval resolves would see the same "most recent resolved approval, not
-- yet superseded by a new one" row and would keep replaying the same trace
-- id forever instead of only on the one wake that actually resumes the gated
-- turn.
ALTER TABLE dashboard_agent_approvals
  ADD COLUMN IF NOT EXISTS trace_id TEXT,
  ADD COLUMN IF NOT EXISTS resumed_at TIMESTAMPTZ;
