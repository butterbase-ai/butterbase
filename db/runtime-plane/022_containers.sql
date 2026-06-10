-- @scope: runtime
-- 022_containers.sql
-- One row per (app, container) for the Containers capability (docs/containers.md).
-- image_id is a LOGICAL FK to control-plane container_images (no constraint —
-- cross-tier FKs are forbidden post-cutover; see 001_initial_runtime_schema.sql).
--
-- Status values UPPERCASE per deployment.service.ts convention. M1 has no
-- server-side builds, so no BUILDING state yet; container_builds arrives in M2.
--
-- Rollback:
--   DROP TABLE IF EXISTS app_container_env_vars;
--   DROP TABLE IF EXISTS app_containers;

CREATE TABLE IF NOT EXISTS app_containers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id            TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,

    -- URL-facing kebab-case name (e.g. 'game-server')
    name              TEXT NOT NULL,

    -- 'pool': stateless round-robin; 'actor': stable instance per key
    mode              TEXT NOT NULL DEFAULT 'pool'
                          CHECK (mode IN ('pool', 'actor')),

    -- Logical FK to control-plane container_images.id
    image_id          UUID,

    instance_type     TEXT NOT NULL DEFAULT 'basic'
                          CHECK (instance_type IN ('dev', 'basic', 'standard')),
    max_instances     INT  NOT NULL DEFAULT 5 CHECK (max_instances BETWEEN 1 AND 10),
    sleep_after_s     INT  NOT NULL DEFAULT 300 CHECK (sleep_after_s BETWEEN 10 AND 3600),
    port              INT  NOT NULL DEFAULT 8080 CHECK (port BETWEEN 1 AND 65535),

    access_mode       TEXT NOT NULL DEFAULT 'service_key'
                          CHECK (access_mode IN ('public', 'authenticated', 'service_key')),

    status            TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'DEPLOYING', 'READY', 'ERROR')),
    error_message     TEXT,

    last_deployed_at  TIMESTAMPTZ,
    -- platform_users.id; no FK — cross-tier logical reference
    deployed_by       UUID,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ,

    UNIQUE (app_id, name)
);

CREATE INDEX IF NOT EXISTS idx_app_containers_app_status
    ON app_containers (app_id, status) WHERE deleted_at IS NULL;

-- Per-container env vars (unlike app_do_env_vars, which is app-wide: each
-- container is its own Worker, so vars scope to one container).
CREATE TABLE IF NOT EXISTS app_container_env_vars (
    container_id      UUID NOT NULL REFERENCES app_containers(id) ON DELETE CASCADE,
    key               TEXT NOT NULL,
    encrypted_value   TEXT NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (container_id, key)
);
