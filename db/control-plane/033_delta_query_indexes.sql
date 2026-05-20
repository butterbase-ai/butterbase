-- @scope: platform
CREATE INDEX IF NOT EXISTS idx_app_users_app_id_created_at
    ON app_users (app_id, created_at);

CREATE INDEX IF NOT EXISTS idx_storage_objects_app_id_created_at
    ON storage_objects (app_id, created_at);
