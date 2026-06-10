-- @scope: platform
-- 088_container_images.sql
-- Global, ref-counted registry of container images (docs/containers.md).
-- Lives in the control plane (not runtime tier) because clone replay (M3) can
-- reference an image from a dest app in a different region; ref-counting must
-- be global. app_containers.image_id in each runtime DB points here logically.
--
-- Rollback:
--   DROP TABLE IF EXISTS container_images;

CREATE TABLE IF NOT EXISTS container_images (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- '{app_id}/{name}' inside our managed registry namespace
    registry_repo   TEXT NOT NULL,
    digest          TEXT NOT NULL,        -- 'sha256:...'
    size_bytes      BIGINT,

    source          TEXT NOT NULL CHECK (source IN ('build', 'push')),

    -- Clones increment; delete/rebuild decrements; GC (M3) only at 0.
    ref_count       INT NOT NULL DEFAULT 1 CHECK (ref_count >= 0),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (registry_repo, digest)
);

CREATE INDEX IF NOT EXISTS idx_container_images_repo ON container_images (registry_repo);
