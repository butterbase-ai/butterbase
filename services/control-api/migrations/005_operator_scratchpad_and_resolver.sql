-- Operator agent: record who resolved an approval, and a per-org scratchpad.

-- 1. resolved_by: which human resolved an operator approval. Nullable —
-- existing rows have no answer, and the human assistant's own
-- approvals/:id/resolve path may not always populate it either. Do not
-- backfill; do not add NOT NULL.
ALTER TABLE dashboard_agent_approvals
  ADD COLUMN IF NOT EXISTS resolved_by TEXT;

-- 2. Per-org operator scratchpad: cheap, agent-authored working memory read
-- into the wake prompt so history can later be bounded without losing
-- continuity. One row per org, replaced (not appended) on every write.
-- organization_id is TEXT to match the other operator tables
-- (dashboard_agent_operator_credentials, dashboard_agent_operator_jobs).
--
-- content is capped at 8000 characters (roughly 2-3k tokens) — this is
-- model-written on a 10-minute cadence with no natural limit, so the bound
-- is enforced here as a hard backstop (CHECK) as well as in the write path,
-- which rejects oversized writes rather than silently truncating them.
CREATE TABLE IF NOT EXISTS dashboard_agent_operator_scratchpad (
  organization_id TEXT PRIMARY KEY,
  content         TEXT NOT NULL DEFAULT '' CHECK (char_length(content) <= 8000),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
