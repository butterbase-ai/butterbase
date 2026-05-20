-- @scope: runtime
-- Phase 5: snapshot tag for move-app's source-side retained runtime rows.
-- Normal application queries should filter WHERE archived_after_move IS NULL.

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'app_users', 'app_refresh_tokens', 'app_verification_codes',
    'app_signing_keys', 'app_oauth_configs', 'app_custom_domains',
    'app_functions', 'function_triggers', 'app_edge_ssr_deployments',
    'app_durable_objects', 'app_realtime_config', 'app_integration_configs',
    'storage_objects', 'app_db_connections',
    'app_orders', 'app_plans', 'app_products', 'app_subscriptions'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS archived_after_move UUID', t);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (archived_after_move) WHERE archived_after_move IS NOT NULL',
        t || '_archived_idx', t);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'app_users') THEN
    EXECUTE 'COMMENT ON COLUMN app_users.archived_after_move IS
  ''Phase 5: non-NULL means the row is a frozen snapshot from a move-app migration. Exclude from normal queries.''';
  END IF;
END $$;
