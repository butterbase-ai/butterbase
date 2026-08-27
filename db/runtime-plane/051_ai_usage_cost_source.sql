-- @scope: runtime
-- 051: Record WHERE provider_cost_usd came from on each charge:
--   'upstream'          — the provider reported the real cost for this call
--                         (OpenRouter usage.cost, provider-secondary's and
--                         provider-tertiary's billing ledgers)
--   'catalog'           — the provider reports no cost, so we multiplied the
--                         router's own published per-Mtok rates by the tokens
--   'catalog_inherited' — same, but the rates were not the router's own: they
--                         were copied from a priced sibling at catalog-refresh
--                         time because this upstream publishes no rate card
--   'catalog_unpriced'  — estimated against a route with NO price at all, so
--                         the charge came out $0. Always a bug; the reconciler
--                         should treat these as unbilled, not as free calls.
--
-- Why: provider_cost_usd is a single NUMERIC with no provenance, so a real
-- settled cost is indistinguishable from a guess, and a $0 row from a genuinely
-- free call. Without this column there is no way to ask "which charges do we
-- still need to reconcile against the vendor's actual bill?" — the exact
-- question Alibaba Model Studio forces on us, since it reports no per-call cost
-- at all and only publishes minute-level aggregates.
--
-- Nullable: rows written before this migration have no recorded source. Read a
-- NULL as "unknown, pre-049" rather than as 'upstream'.
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS cost_source text;

-- Reconciliation queue: the inferred rows, newest first. Partial so it stays
-- small — the overwhelming majority of rows are 'upstream' and never queried
-- through this path.
CREATE INDEX IF NOT EXISTS ai_usage_logs_cost_source_unreconciled_idx
  ON ai_usage_logs (created_at DESC)
  WHERE cost_source IN ('catalog', 'catalog_inherited', 'catalog_unpriced');
