-- @scope: data
-- RLS Role-Based Access Control
-- Creates non-privileged PostgreSQL roles for RLS enforcement.
-- The connection role (neondb_owner on Neon, butterbase locally) has BYPASSRLS,
-- so we must SET LOCAL ROLE to one of these roles to make RLS effective.

-- Create roles (idempotent, NOLOGIN, no BYPASSRLS)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'butterbase_anon') THEN
    CREATE ROLE butterbase_anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'butterbase_user') THEN
    CREATE ROLE butterbase_user NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'butterbase_service') THEN
    CREATE ROLE butterbase_service NOLOGIN;
  END IF;
END $$;

-- Grant schema access
GRANT USAGE ON SCHEMA public TO butterbase_anon, butterbase_user, butterbase_service;

-- Grant access to existing tables, sequences, and functions
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO butterbase_anon, butterbase_user, butterbase_service;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO butterbase_anon, butterbase_user, butterbase_service;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO butterbase_anon, butterbase_user, butterbase_service;

-- Ensure future objects get the same grants
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO butterbase_anon, butterbase_user, butterbase_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO butterbase_anon, butterbase_user, butterbase_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO butterbase_anon, butterbase_user, butterbase_service;

-- Grant role membership to the current connection role so SET LOCAL ROLE works
DO $$ BEGIN
  EXECUTE format('GRANT butterbase_anon TO %I', current_user);
  EXECUTE format('GRANT butterbase_user TO %I', current_user);
  EXECUTE format('GRANT butterbase_service TO %I', current_user);
END $$;
