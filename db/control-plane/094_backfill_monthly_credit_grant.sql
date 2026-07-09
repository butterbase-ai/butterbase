-- @scope: platform
-- 094: Backfill plans.monthly_credit_grant_usd from plans.max_ai_credits_usd,
-- and re-run monthly allowance for currently-active subs.
--
-- Bug: migration 066 added plans.monthly_credit_grant_usd with DEFAULT 0 and
-- left a comment "old columns max_ai_credits_usd / ai_credits_lifetime stay
-- for one release so the backfill script can read them" — but the backfill
-- was never landed. resetMonthlyAllowanceWithClient reads
-- monthly_credit_grant_usd, so every plan grants $0/mo despite the pricing
-- page (and manage_billing status) advertising $1/$5/$15 monthly AI credits.
--
-- Fix:
-- 1. Backfill plans.monthly_credit_grant_usd from plans.max_ai_credits_usd
--    (the column migration 024 seeded to 1.00 / 5.00 / 15.00). Only fill
--    where the grant is still 0 so anyone who set a custom value keeps it.
-- 2. Retroactively grant the monthly allowance to every currently-active
--    (or trialing) subscription whose org is below the expected grant. This
--    unblocks existing paying customers immediately instead of waiting for
--    their next invoice.paid webhook.

BEGIN;

-- 1. Plan-level backfill: monthly_credit_grant_usd ← max_ai_credits_usd.
UPDATE plans
   SET monthly_credit_grant_usd = max_ai_credits_usd
 WHERE monthly_credit_grant_usd = 0
   AND max_ai_credits_usd > 0;

-- 2. Org-level backfill: for every active/trialing sub, raise the org's
--    monthly_allowance_usd up to the plan's grant. Never lowers an org that
--    somehow has more than the grant (top-ups live in credits_usd, not this
--    column, so this is unlikely — but keep it defensive).
UPDATE organizations o
   SET monthly_allowance_usd = p.monthly_credit_grant_usd
  FROM subscriptions s
  JOIN plans p ON p.id = s.plan_id
 WHERE s.organization_id = o.id
   AND s.status IN ('active', 'trialing')
   AND o.monthly_allowance_usd < p.monthly_credit_grant_usd;

COMMIT;
