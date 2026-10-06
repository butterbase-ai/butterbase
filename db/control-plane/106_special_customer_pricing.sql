-- @scope: platform
-- 106: Special-customer pricing. Orgs flagged special_pricing are charged the
-- per-model markup_pct from special_model_markups (replacement for the global
-- AI_MARKUP_PERCENT) on AI usage. Book keys are canonical Redis catalog ids.
-- Number 106 (not 105): 105 was consumed by the archived branch
-- archive/2026-08-05-org-special-pricing-superseded; _migrations keys on
-- filename, so reusing the number with different SQL would silently collide
-- if that branch were ever revived.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS special_pricing boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS special_model_markups (
  canonical_model_id text PRIMARY KEY,
  markup_pct         numeric(6,3) NOT NULL CHECK (markup_pct >= 0 AND markup_pct <= 200),
  updated_by         uuid NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
