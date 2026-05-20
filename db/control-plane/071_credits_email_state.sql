-- @scope: platform
-- 071_credits_email_state.sql
-- Dedup state for credits_low and credits_exhausted billing emails.
-- Set when the corresponding email is sent; cleared whenever the user's
-- credit balance crosses back above the low threshold (top-up, grant,
-- monthly reset).
ALTER TABLE platform_users
  ADD COLUMN credits_low_emailed_at TIMESTAMPTZ NULL,
  ADD COLUMN credits_exhausted_emailed_at TIMESTAMPTZ NULL;
