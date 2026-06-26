-- @scope: platform
-- DCR (RFC 7591) client registry. Anyone can POST to /oauth/register and get a
-- client_id; we don't store secrets (PKCE-only flows). redirect_uris is small
-- and validated server-side; we keep last_used_at so we can GC stale rows.
CREATE TABLE oauth_clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text NOT NULL UNIQUE,
  client_name     text,
  redirect_uris   text[] NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz
);

CREATE INDEX idx_oauth_clients_last_used ON oauth_clients (last_used_at);

-- Short-lived (≤60s) authorization codes. code_hash is sha256(code) — we never
-- store the plaintext. consumed_at is set on first /oauth/token exchange to
-- enforce single-use. requested_target captures the consent payload (app_id,
-- read_only, additional_scopes) so the token mint at /oauth/token can reproduce
-- exactly what the user approved without re-trusting the client.
CREATE TABLE oauth_authorization_codes (
  code_hash             text PRIMARY KEY,
  client_id             text NOT NULL REFERENCES oauth_clients(client_id),
  user_id               uuid NOT NULL REFERENCES platform_users(id),
  redirect_uri          text NOT NULL,
  scope                 text NOT NULL,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL CHECK (code_challenge_method = 'S256'),
  requested_target      jsonb NOT NULL,
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz
);

CREATE INDEX idx_oauth_codes_expires ON oauth_authorization_codes (expires_at);
