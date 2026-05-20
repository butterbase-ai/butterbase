-- @scope: platform
-- Migration 007: Storage Enhancements
-- Adds user_id tracking and storage configuration

-- Add new columns to storage_objects
ALTER TABLE storage_objects
ADD COLUMN IF NOT EXISTS user_id UUID,
ADD COLUMN IF NOT EXISTS filename TEXT,
ADD COLUMN IF NOT EXISTS content_type TEXT;

-- Rename old mime_type column (we'll drop it after)
ALTER TABLE storage_objects
RENAME COLUMN mime_type TO mime_type_old;

-- Add foreign key constraint
ALTER TABLE storage_objects
ADD CONSTRAINT storage_objects_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE SET NULL;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_storage_objects_user_id ON storage_objects(user_id);

-- Add storage configuration to apps table
ALTER TABLE apps
ADD COLUMN IF NOT EXISTS storage_config JSONB DEFAULT '{
  "maxFileSizeMb": 10,
  "allowedContentTypes": ["*/*"],
  "publicReadEnabled": false
}'::jsonb;

-- Migrate data from mime_type_old to content_type before dropping
UPDATE storage_objects SET content_type = mime_type_old WHERE content_type IS NULL;

-- Drop old mime_type column with IF EXISTS for idempotency
ALTER TABLE storage_objects DROP COLUMN IF EXISTS mime_type_old;
