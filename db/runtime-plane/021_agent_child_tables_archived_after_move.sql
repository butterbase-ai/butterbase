-- @scope: runtime
-- Phase 2 (agent-feature salvage) — follow-up to 019.
--
-- 019 added archived_after_move to the four agent tables that carry app_id
-- directly. The follow-up plan documented in that file intentionally LEFT OUT
-- the four child tables (agent_checkpoints, agent_run_events, agent_usage,
-- agent_webhook_deliveries) — they FK on agent_runs(id) via run_id, with
-- ON DELETE CASCADE — accepting that any cross-region move would silently
-- drop run history.
--
-- A smoke test of the move-app saga against an app with active agent runs
-- caught the data loss in pre-prod. We are no longer accepting it: the saga
-- is being extended to also copy these child tables (resolved through their
-- parent's app_id), and that copy step needs the same archived_after_move
-- tag the parent tables use so source-side rows can be hidden from normal
-- reads after the move without an immediate hard delete.
--
-- This migration is additive (column add + partial index) and idempotent.

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'agent_checkpoints',
    'agent_run_events',
    'agent_usage',
    'agent_webhook_deliveries'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS archived_after_move UUID', t);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (archived_after_move) WHERE archived_after_move IS NOT NULL',
        t || '_archived_idx', t);
    END IF;
  END LOOP;
END $$;
