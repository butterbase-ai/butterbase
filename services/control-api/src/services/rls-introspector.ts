/**
 * RLS introspector for clone jobs.
 *
 * Reads pg_policies from the source app's database so that the clone worker
 * can regenerate the same policies on the dest app's database, plus the
 * per-table RLS toggles from pg_class — WITHOUT which the regenerated policies
 * are inert (see introspectRlsTables).
 */

import type pg from 'pg';

export interface RlsPolicy {
  table: string;
  name: string;
  /**
   * pg_policies.cmd, as Postgres actually returns it: 'ALL' | 'SELECT' |
   * 'INSERT' | 'UPDATE' | 'DELETE'. The single-char forms ('r','a','w','d','*')
   * belong to pg_policy.polcmd, a DIFFERENT relation — mapPolicyCommand accepts
   * both so a caller reading either one is safe.
   */
  command: string;
  permissive: boolean;
  roles: string[];
  using: string | null;
  with_check: string | null;
}

/** Whether a table enforces RLS, and whether it does so even for its owner. */
export interface RlsTableState {
  table: string;
  enabled: boolean;
  forced: boolean;
}

const EXCLUDED_TABLES = new Set(['_ai_migrations', '_seed_tables']);

/** Tables the app owns, as opposed to Butterbase's own bookkeeping. */
function isAppTable(name: string): boolean {
  return !EXCLUDED_TABLES.has(name) && !name.startsWith('app_') && !name.startsWith('_');
}

/**
 * Parse a Postgres `name[]` / `text[]` literal that arrived as a raw string.
 *
 * `pg_policies.roles` has type `name[]` (OID 1003). node-pg ships parsers for
 * `text[]` and friends but NOT for `name[]`, so it hands the value back as the
 * literal string `"{butterbase_user}"`. The previous code tested
 * `Array.isArray(...)` and fell back to `[]` on every single row, which made
 * replayRls emit `TO PUBLIC` for every policy it replayed — widening the
 * audience of each one, and in the case of a `butterbase_service` bypass policy
 * (`USING (true)`) making the whole table readable by everyone once RLS was on.
 *
 * Accepts an already-parsed array too, so this keeps working if a future
 * node-pg registers an OID 1003 parser or a caller casts to `text[]`.
 */
export function parsePgNameArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
  const inner = trimmed.slice(1, -1);
  if (inner === '') return [];

  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQuotes) {
      if (ch === '\\') { cur += inner[++i] ?? ''; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

const POLCMD_CHARS: Record<string, string> = {
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE',
  '*': 'ALL',
};

const CMD_WORDS = new Set(['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']);

/**
 * Normalize a policy command to the keyword `CREATE POLICY ... FOR <cmd>` wants.
 *
 * The old CMD_MAP keyed ONLY on the single-char pg_policy.polcmd values, but the
 * introspector reads pg_policies, whose `cmd` column is the full word. Every
 * lookup therefore missed and fell through to 'ALL' — so a `FOR SELECT` policy
 * was recreated with INSERT/UPDATE/DELETE coverage it never had. Both encodings
 * are accepted here so neither reading is silently widened.
 */
export function mapPolicyCommand(cmd: string | null | undefined): string {
  if (!cmd) return 'ALL';
  const upper = cmd.toUpperCase();
  if (CMD_WORDS.has(upper)) return upper;
  return POLCMD_CHARS[cmd] ?? 'ALL';
}

export async function introspectRls(pool: pg.Pool): Promise<RlsPolicy[]> {
  const res = await pool.query(`
    SELECT tablename, policyname, cmd, permissive, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
  `);
  return res.rows
    .filter(r => isAppTable(r.tablename))
    .map(r => ({
      table: r.tablename,
      name: r.policyname,
      command: r.cmd as string,
      permissive: r.permissive === 'PERMISSIVE' || r.permissive === true,
      roles: parsePgNameArray(r.roles),
      using: r.qual ?? null,
      with_check: r.with_check ?? null,
    }));
}

/**
 * Per-table RLS toggles.
 *
 * Postgres only ENFORCES policies when `relrowsecurity` is set on the table; a
 * table carrying policies with RLS off is wide open. pg_policies says nothing
 * about that flag, so replaying policies alone — which is all clone and update
 * ever did — produced destination tables whose policies were decorative.
 *
 * Returns every app table with RLS enabled, INCLUDING ones with no policies at
 * all: "enabled, no policies" is a deliberate deny-all, and keying off the
 * policy list would silently discard it.
 */
export async function introspectRlsTables(pool: pg.Pool): Promise<RlsTableState[]> {
  const res = await pool.query(`
    SELECT c.relname AS tablename,
           c.relrowsecurity AS enabled,
           c.relforcerowsecurity AS forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity
  `);
  return res.rows
    .filter(r => isAppTable(r.tablename))
    .map(r => ({
      table: r.tablename,
      enabled: r.enabled === true,
      forced: r.forced === true,
    }));
}
