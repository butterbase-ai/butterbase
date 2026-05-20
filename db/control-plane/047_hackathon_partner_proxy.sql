-- @scope: platform
-- 047_hackathon_partner_proxy.sql
-- Generic HTTP forwarder for hackathon partner APIs (Seedance, Z.AI, etc.).
-- partner_pools = data-only config per partner (one row = one partner).
-- partner_keys  = pool of host-supplied API keys with health status.
-- partner_proxy_logs = per-request observability; not used for quota.

CREATE TABLE IF NOT EXISTS partner_pools (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hackathon_id    UUID NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
    slug            TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    base_url        TEXT NOT NULL,
    -- auth_template shape: { "location": "header"|"query", "name": "X-API-Key"|"Authorization"|"api_key", "template": "Bearer {{key}}" }
    auth_template   JSONB NOT NULL,
    contact_message TEXT NOT NULL DEFAULT 'Contact the hackathon host for additional access.',
    docs_url        TEXT,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (hackathon_id, slug)
);

CREATE INDEX idx_partner_pools_hackathon ON partner_pools (hackathon_id);

CREATE TABLE IF NOT EXISTS partner_keys (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id             UUID NOT NULL REFERENCES partner_pools(id) ON DELETE CASCADE,
    encrypted_key       TEXT NOT NULL, -- AES-256-GCM via services/crypto.ts (iv:ciphertext:authTag)
    label               TEXT, -- optional admin nickname e.g. "seedance-key-3"
    status              TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','exhausted','revoked')),
    last_used_at        TIMESTAMPTZ,
    last_failed_at      TIMESTAMPTZ,
    last_failure_status INT,
    last_failure_body   TEXT, -- truncated to 1KB
    failure_count       INT NOT NULL DEFAULT 0,
    use_count           BIGINT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot-path index: pick least-recently-used active key per pool.
-- NULLS FIRST so never-used keys are picked before reused ones.
CREATE INDEX idx_partner_keys_pool_active_lru
    ON partner_keys (pool_id, last_used_at NULLS FIRST)
    WHERE status = 'active';

CREATE INDEX idx_partner_keys_pool_status ON partner_keys (pool_id, status);

CREATE TABLE IF NOT EXISTS partner_proxy_logs (
    id              BIGSERIAL PRIMARY KEY,
    pool_id         UUID NOT NULL REFERENCES partner_pools(id) ON DELETE CASCADE,
    key_id          UUID REFERENCES partner_keys(id) ON DELETE SET NULL,
    app_id          TEXT,
    user_id         UUID,
    method          TEXT NOT NULL,
    path            TEXT NOT NULL,
    status_code     INT,
    bytes_in        BIGINT,
    bytes_out       BIGINT,
    latency_ms      INT,
    failover_attempts INT NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ppl_pool_created ON partner_proxy_logs (pool_id, created_at DESC);
CREATE INDEX idx_ppl_user_created ON partner_proxy_logs (user_id, created_at DESC);

-- updated_at trigger on partner_pools
CREATE OR REPLACE FUNCTION partner_pools_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_partner_pools_updated_at
BEFORE UPDATE ON partner_pools
FOR EACH ROW EXECUTE FUNCTION partner_pools_set_updated_at();
