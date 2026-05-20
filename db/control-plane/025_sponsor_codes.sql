-- @scope: platform
-- Sponsor codes for hackathon/promotional upgrades
-- Tracks codes, their credit values, redemption limits, and per-user redemptions

CREATE TABLE IF NOT EXISTS sponsor_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  sponsor TEXT NOT NULL,                       -- e.g. 'beta-angel-fund'
  hackathon TEXT,                              -- e.g. 'vibe-a-thon-2026-04'
  plan_id TEXT NOT NULL REFERENCES plans(id),  -- which plan the code upgrades to
  credit_cents INTEGER NOT NULL,               -- e.g. 1900 = $19.00
  months_covered INTEGER NOT NULL DEFAULT 1,
  max_redemptions INTEGER NOT NULL DEFAULT 20,
  current_redemptions INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,                      -- NULL = never expires
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sponsor_code_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_code_id UUID NOT NULL REFERENCES sponsor_codes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sponsor_code_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sponsor_code_redemptions_user ON sponsor_code_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_sponsor_codes_code ON sponsor_codes(code);

-- Track whether the user has completed the post-signup onboarding step
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT false;

-- Seed the first sponsor code
INSERT INTO sponsor_codes (code, sponsor, hackathon, plan_id, credit_cents, months_covered, max_redemptions, expires_at)
VALUES ('BETA-STOODY', 'beta-angel-fund', 'vibe-a-thon-2026-04', 'launch', 1900, 1, 20, '2026-04-15T23:59:59Z');
