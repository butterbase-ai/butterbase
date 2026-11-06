-- @scope: platform
-- Task 9 — an organization can now own more than one of a member's
-- conversations.
--
-- `dashboard_agent_conversations_operator_uniq` was created when the ONLY
-- organization-bound conversation was the operator's singleton, so
-- `organization_id IS NOT NULL` was an accurate proxy for "this is the
-- operator conversation". Office provenance makes that proxy false: every
-- Office-origin Ask conversation is org-bound, and the index then forbids a
-- member from having a second one in the same organization — duplicating a
-- conversation, or starting a fresh Ask, fails with a unique violation.
--
-- Narrow the predicate to the fact the index was always meant to express:
-- exactly one OPERATOR conversation per organization. Operator conversations
-- are identified structurally by the sentinel user id `operator:<org>`
-- (operator-store.ts), not by a flag, so this cannot drift from the code that
-- creates them. `getOrCreateOperatorConversation`'s ON CONFLICT inference
-- carries the same predicate; keep the two identical or PostgreSQL will not
-- match the index.
--
-- Existing data cannot violate the narrowed predicate: every row it now
-- excludes had organization_id NULL, which the old predicate already
-- excluded.
DROP INDEX IF EXISTS dashboard_agent_conversations_operator_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_agent_conversations_operator_uniq
  ON dashboard_agent_conversations (organization_id, user_id)
  WHERE organization_id IS NOT NULL
    AND user_id = 'operator:' || organization_id;
