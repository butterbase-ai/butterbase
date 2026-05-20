-- @scope: platform
-- 053_durable_objects.sql
-- Create app_durable_objects and app_do_deploy_state tables for the Durable Objects feature.
-- app_durable_objects holds one row per DO class per app: the source code, parsed class name,
-- URL-facing kebab-case name, access mode, and deployment lifecycle status.
-- app_do_deploy_state holds a single snapshot row per app recording the last successful
-- bundle deployment (class names in the bundle, sha, and timestamp) for reconciliation
-- and fast re-deploy checks.
--
-- Status values use UPPERCASE strings (same convention as deployment.service.ts and
-- the Edge SSR migration 052).
--
-- Rollback:
--   DROP TABLE IF EXISTS app_do_deploy_state;
--   DROP TABLE IF EXISTS app_durable_objects;

CREATE TABLE IF NOT EXISTS app_durable_objects (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id            TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,

    -- URL-facing kebab-case name (e.g. 'chat-room')
    name              TEXT NOT NULL,

    -- Actual TypeScript class name parsed from source (e.g. 'ChatRoom')
    class_name        TEXT NOT NULL,

    -- Full single-file TS/JS source and its SHA for change detection
    code              TEXT NOT NULL,
    code_sha          TEXT NOT NULL,

    -- Who may call this DO's HTTP interface
    access_mode       TEXT NOT NULL DEFAULT 'authenticated'
                          CHECK (access_mode IN ('public', 'authenticated', 'service_key')),

    -- Deployment lifecycle
    status            TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'BUILDING', 'READY', 'ERROR', 'SUPERSEDED')),
    error_message     TEXT,

    -- Timing
    last_deployed_at  TIMESTAMPTZ,

    -- Audit
    deployed_by       UUID REFERENCES platform_users(id),

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (app_id, name)
);

-- Efficient lookup of all DOs for an app filtered by status
CREATE INDEX IF NOT EXISTS idx_durable_objects_app_status
    ON app_durable_objects (app_id, status);

-- One row per app: snapshot of the last successful bundle deploy
CREATE TABLE IF NOT EXISTS app_do_deploy_state (
    app_id               TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,

    -- Class names present in the last successfully deployed bundle
    deployed_class_names TEXT[] NOT NULL DEFAULT '{}',

    -- SHA of the deployed bundle for change detection
    bundle_sha           TEXT,

    -- When the bundle was last deployed
    deployed_at          TIMESTAMPTZ
);
