-- @scope: data
-- RLS Role-Based Architecture
-- Implements production-style automatic service bypass policies

-- Event trigger function to auto-create service bypass policy when RLS is enabled
CREATE OR REPLACE FUNCTION butterbase_auto_service_policy()
RETURNS event_trigger AS $$
DECLARE
  obj record;
  schema_name text;
  table_name text;
  full_table_name text;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF obj.command_tag = 'ALTER TABLE' AND obj.object_type = 'table' THEN
      full_table_name := obj.object_identity;

      -- Check if RLS is enabled on this table
      SELECT schemaname, tablename INTO schema_name, table_name
      FROM pg_tables
      WHERE schemaname || '.' || tablename = full_table_name
        AND rowsecurity = true;

      IF FOUND THEN
        -- Check if service policy already exists (PG 14 compatible)
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = schema_name
            AND tablename = table_name
            AND policyname = 'butterbase_service_policy'
        ) THEN
          -- Create service bypass policy
          EXECUTE format(
            'CREATE POLICY "butterbase_service_policy" ON %I.%I
             FOR ALL
             USING ((select current_setting(''app.role'', true)) = ''butterbase_service'')
             WITH CHECK ((select current_setting(''app.role'', true)) = ''butterbase_service'')',
            schema_name, table_name
          );

          RAISE NOTICE 'Created butterbase_service_policy on %.%', schema_name, table_name;
        END IF;
      END IF;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Create event trigger
DROP EVENT TRIGGER IF EXISTS butterbase_auto_service_policy_trigger;
CREATE EVENT TRIGGER butterbase_auto_service_policy_trigger
  ON ddl_command_end
  WHEN TAG IN ('ALTER TABLE')
  EXECUTE FUNCTION butterbase_auto_service_policy();

-- Backfill existing RLS-enabled tables with service policy
DO $$
DECLARE
  tbl record;
BEGIN
  FOR tbl IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      AND rowsecurity = true
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = tbl.schemaname
        AND tablename = tbl.tablename
        AND policyname = 'butterbase_service_policy'
    ) THEN
      EXECUTE format(
        'CREATE POLICY "butterbase_service_policy" ON %I.%I
         FOR ALL
         USING ((select current_setting(''app.role'', true)) = ''butterbase_service'')
         WITH CHECK ((select current_setting(''app.role'', true)) = ''butterbase_service'')',
        tbl.schemaname, tbl.tablename
      );

      RAISE NOTICE 'Backfilled butterbase_service_policy on %.%',
        tbl.schemaname, tbl.tablename;
    END IF;
  END LOOP;
END $$;
