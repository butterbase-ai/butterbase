-- @scope: platform
-- Add per-object visibility flag to storage_objects
ALTER TABLE storage_objects
ADD COLUMN IF NOT EXISTS public BOOLEAN NOT NULL DEFAULT false;

-- Partial index for queries filtering by public objects
CREATE INDEX IF NOT EXISTS idx_storage_objects_app_public
ON storage_objects (app_id, public) WHERE public = true;
