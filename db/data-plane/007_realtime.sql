-- @scope: data
-- Migration 006: Realtime Schema for Table Change Notifications
--
-- Creates the infrastructure for pg_notify-based realtime events:
-- 1. realtime.watched_tables - tracks which tables have triggers
-- 2. realtime.changes - transient change relay table
-- 3. Per-table trigger functions that capture INSERT/UPDATE/DELETE
-- 4. pg_notify on changes for the realtime manager to broadcast via WebSocket

-- ============================================================================
-- CREATE SCHEMA
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS realtime;

-- ============================================================================
-- WATCHED TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS realtime.watched_tables (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name TEXT UNIQUE NOT NULL,
  events TEXT[] DEFAULT ARRAY['INSERT','UPDATE','DELETE'] NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- CHANGES TABLE (transient relay — cleaned up every few minutes)
-- ============================================================================

CREATE TABLE IF NOT EXISTS realtime.changes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),
  record JSONB,
  old_record JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_realtime_changes_created
  ON realtime.changes(created_at DESC);

-- ============================================================================
-- NOTIFY TRIGGER ON CHANGES TABLE
-- ============================================================================

CREATE OR REPLACE FUNCTION realtime.notify_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Send only change ID to bypass pg_notify 8KB payload limit.
  -- The realtime manager fetches the full record from the table.
  PERFORM pg_notify('realtime_changes', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_realtime_notify ON realtime.changes;
CREATE TRIGGER trg_realtime_notify
  AFTER INSERT ON realtime.changes
  FOR EACH ROW
  EXECUTE FUNCTION realtime.notify_change();

-- ============================================================================
-- ENABLE TABLE TRIGGER
-- ============================================================================
-- Called by the configure_realtime API to install a change-capture trigger
-- on a user table. The trigger writes to realtime.changes on every
-- INSERT, UPDATE, or DELETE.

CREATE OR REPLACE FUNCTION realtime.enable_table_trigger(p_table_name TEXT)
RETURNS VOID AS $$
DECLARE
  trigger_fn_name TEXT;
  trigger_name TEXT;
BEGIN
  trigger_fn_name := 'notify_' || replace(p_table_name, '.', '_');
  trigger_name := 'trg_realtime_' || replace(p_table_name, '.', '_');

  -- Create the per-table trigger function (schema-qualified with %I.%I for safety)
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION realtime.%I()
    RETURNS TRIGGER AS $t$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        INSERT INTO realtime.changes (table_name, op, old_record)
        VALUES (TG_TABLE_NAME, TG_OP, to_jsonb(OLD));
        RETURN OLD;
      ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO realtime.changes (table_name, op, record, old_record)
        VALUES (TG_TABLE_NAME, TG_OP, to_jsonb(NEW), to_jsonb(OLD));
        RETURN NEW;
      ELSE
        INSERT INTO realtime.changes (table_name, op, record)
        VALUES (TG_TABLE_NAME, TG_OP, to_jsonb(NEW));
        RETURN NEW;
      END IF;
    END;
    $t$ LANGUAGE plpgsql SECURITY DEFINER;
  $f$, trigger_fn_name);

  -- Drop existing trigger if any, then create
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', trigger_name, p_table_name);
  EXECUTE format(
    'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION realtime.%I()',
    trigger_name, p_table_name, trigger_fn_name
  );

  -- Record the watched table
  INSERT INTO realtime.watched_tables (table_name)
  VALUES (p_table_name)
  ON CONFLICT (table_name) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- DISABLE TABLE TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION realtime.disable_table_trigger(p_table_name TEXT)
RETURNS VOID AS $$
DECLARE
  trigger_fn_name TEXT;
  trigger_name TEXT;
BEGIN
  trigger_fn_name := 'notify_' || replace(p_table_name, '.', '_');
  trigger_name := 'trg_realtime_' || replace(p_table_name, '.', '_');

  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', trigger_name, p_table_name);
  EXECUTE format('DROP FUNCTION IF EXISTS realtime.%I()', trigger_fn_name);
  DELETE FROM realtime.watched_tables WHERE table_name = p_table_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- CLEANUP FUNCTION
-- ============================================================================
-- Deletes changes older than 5 minutes. Called periodically by the
-- realtime plugin in the control API.

CREATE OR REPLACE FUNCTION realtime.cleanup_old_changes()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM realtime.changes
  WHERE created_at < NOW() - INTERVAL '5 minutes';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT USAGE ON SCHEMA realtime TO butterbase_anon, butterbase_user, butterbase_service;
GRANT SELECT ON realtime.watched_tables TO butterbase_anon, butterbase_user, butterbase_service;
GRANT SELECT, INSERT ON realtime.changes TO butterbase_service, butterbase_user;
