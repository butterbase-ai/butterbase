/**
 * RLS introspector for clone jobs.
 *
 * Reads pg_policies from the source app's database so that the clone worker
 * can regenerate the same policies on the dest app's database.
 */

import type pg from 'pg';

export interface RlsPolicy {
  table: string;
  name: string;
  command: 'r' | 'a' | 'w' | 'd' | '*';  // pg_policies.cmd: SELECT='r', INSERT='a', UPDATE='w', DELETE='d', ALL='*'
  permissive: boolean;
  roles: string[];
  using: string | null;
  with_check: string | null;
}

const EXCLUDED_TABLES = new Set(['_ai_migrations', '_seed_tables']);

export async function introspectRls(pool: pg.Pool): Promise<RlsPolicy[]> {
  const res = await pool.query(`
    SELECT tablename, policyname, cmd, permissive, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
  `);
  return res.rows
    .filter(r => !EXCLUDED_TABLES.has(r.tablename) && !r.tablename.startsWith('app_') && !r.tablename.startsWith('_'))
    .map(r => ({
      table: r.tablename,
      name: r.policyname,
      command: r.cmd as 'r' | 'a' | 'w' | 'd' | '*',
      permissive: r.permissive === 'PERMISSIVE',
      roles: Array.isArray(r.roles) ? r.roles : [],
      using: r.qual ?? null,
      with_check: r.with_check ?? null,
    }));
}
