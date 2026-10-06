-- @scope: platform

-- Paging the operator trace viewer selects the page from WAKE messages: one
-- row per turn, `WHERE conversation_id = $1 AND role = 'user'`, ordered by
-- `(created_at, id)`.
--
-- The only index on this table is `(conversation_id, created_at)`, which does
-- not carry `role`, so that query reads every message of the conversation and
-- discards ~97% of them (a turn is one wake plus its whole tool transcript).
-- One operator conversation per org is reused FOREVER, so that cost grows
-- without bound — the exact failure the module's own header warns about.
--
-- Partial, because `role = 'user'` is a fixed predicate of the only query that
-- uses this: the index then holds one entry per TURN rather than per message.
-- `(created_at, id)` matches the ORDER BY and the cursor's row-value
-- comparison exactly, so paging is an index scan from the cursor rather than a
-- sort.
--
-- CONCURRENTLY is deliberately NOT used: it cannot run inside the migration
-- runner's transaction. The table is small enough per conversation that the
-- brief lock is not worth splitting this into an out-of-band step.
CREATE INDEX IF NOT EXISTS dashboard_agent_messages_wake_idx
  ON dashboard_agent_messages (conversation_id, created_at, id)
  WHERE role = 'user';
