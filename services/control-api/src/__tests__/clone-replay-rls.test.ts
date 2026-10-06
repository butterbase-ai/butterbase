import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { replayRls } from '../services/clone-replay.js';
import { parsePgNameArray, mapPolicyCommand } from '../services/rls-introspector.js';

const logger = { info: vi.fn(), warn: vi.fn() };

/**
 * A fake pool that answers the introspection queries replayRls issues against
 * the SOURCE, and records every statement issued against the DEST.
 */
function fakePools(opts: {
  policies?: Record<string, unknown>[];
  tableState?: Record<string, unknown>[];
  failOn?: RegExp;
}) {
  const issued: string[] = [];
  const source = {
    query: async (sql: string) => {
      if (/FROM pg_policies/i.test(sql)) return { rows: opts.policies ?? [] };
      if (/pg_class/i.test(sql)) return { rows: opts.tableState ?? [] };
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const dest = {
    query: async (sql: string) => {
      issued.push(sql);
      if (opts.failOn && opts.failOn.test(sql)) throw new Error('boom');
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  return { source, dest, issued };
}

// pg_policies.roles is `name[]` (OID 1003). node-pg has no parser registered for
// that OID, so it hands back the RAW STRING "{butterbase_user}" rather than an
// array. The old code did `Array.isArray(r.roles) ? r.roles : []`, which took the
// `[]` branch every single time — so every replayed policy came out `TO PUBLIC`.
describe('parsePgNameArray', () => {
  it('parses a real pg name[] literal that node-pg left as a string', () => {
    expect(parsePgNameArray('{butterbase_user}')).toEqual(['butterbase_user']);
    expect(parsePgNameArray('{a,b}')).toEqual(['a', 'b']);
  });

  it('parses an empty array literal', () => {
    expect(parsePgNameArray('{}')).toEqual([]);
  });

  it('handles quoted role names containing commas or spaces', () => {
    expect(parsePgNameArray('{"weird, role",plain}')).toEqual(['weird, role', 'plain']);
  });

  it('passes through a value node-pg already parsed into an array', () => {
    expect(parsePgNameArray(['butterbase_user'])).toEqual(['butterbase_user']);
  });

  it('treats null/undefined as no roles', () => {
    expect(parsePgNameArray(null)).toEqual([]);
    expect(parsePgNameArray(undefined)).toEqual([]);
  });
});

// pg_policies.cmd is TEXT — 'ALL' / 'SELECT' / 'INSERT' / 'UPDATE' / 'DELETE'.
// The old CMD_MAP keyed on the pg_policy.polcmd CHARS ('r','a','w','d','*'), so
// every lookup missed and fell back to 'ALL'. A SELECT-only policy was replayed
// with write coverage it never had.
describe('mapPolicyCommand', () => {
  it('preserves a SELECT-only policy instead of widening it to ALL', () => {
    expect(mapPolicyCommand('SELECT')).toBe('SELECT');
  });

  it('maps every pg_policies.cmd value', () => {
    expect(mapPolicyCommand('ALL')).toBe('ALL');
    expect(mapPolicyCommand('INSERT')).toBe('INSERT');
    expect(mapPolicyCommand('UPDATE')).toBe('UPDATE');
    expect(mapPolicyCommand('DELETE')).toBe('DELETE');
  });

  it('still accepts the raw polcmd chars, for callers reading pg_policy directly', () => {
    expect(mapPolicyCommand('r')).toBe('SELECT');
    expect(mapPolicyCommand('*')).toBe('ALL');
  });

  it('falls back to ALL for anything unrecognized', () => {
    expect(mapPolicyCommand('nonsense')).toBe('ALL');
  });
});

describe('replayRls', () => {
  const policyRow = {
    tablename: 'secret_notes',
    policyname: 'owner_only',
    cmd: 'SELECT',
    permissive: 'PERMISSIVE',
    roles: '{butterbase_user}',
    qual: 'user_id = current_setting(\'app.user_id\', true)',
    with_check: null,
  };

  it('grants the policy to the source roles, not PUBLIC', async () => {
    const { source, dest, issued } = fakePools({ policies: [policyRow] });
    await replayRls(source, dest, logger);
    const create = issued.find((s) => /CREATE POLICY/i.test(s))!;
    expect(create).toMatch(/TO "butterbase_user"/);
    expect(create).not.toMatch(/TO PUBLIC/);
  });

  it('preserves FOR SELECT rather than widening to FOR ALL', async () => {
    const { source, dest, issued } = fakePools({ policies: [policyRow] });
    await replayRls(source, dest, logger);
    expect(issued.find((s) => /CREATE POLICY/i.test(s))!).toMatch(/FOR SELECT/);
  });

  // The whole point. Postgres only ENFORCES policies once RLS is enabled on the
  // table; a table with policies and relrowsecurity=false is wide open. The
  // clone/update path created policies and never enabled anything, so every
  // fork's "protected" tables were readable in full.
  it('enables RLS on tables the source has it enabled on', async () => {
    const { source, dest, issued } = fakePools({
      policies: [policyRow],
      tableState: [{ tablename: 'secret_notes', enabled: true, forced: false }],
    });
    await replayRls(source, dest, logger);
    expect(issued.some((s) => /ALTER TABLE "secret_notes" ENABLE ROW LEVEL SECURITY/i.test(s))).toBe(true);
  });

  it('mirrors FORCE ROW LEVEL SECURITY when the source forces it', async () => {
    const { source, dest, issued } = fakePools({
      policies: [policyRow],
      tableState: [{ tablename: 'secret_notes', enabled: true, forced: true }],
    });
    await replayRls(source, dest, logger);
    expect(issued.some((s) => /FORCE ROW LEVEL SECURITY/i.test(s))).toBe(true);
  });

  it('does not force RLS when the source does not', async () => {
    const { source, dest, issued } = fakePools({
      policies: [policyRow],
      tableState: [{ tablename: 'secret_notes', enabled: true, forced: false }],
    });
    await replayRls(source, dest, logger);
    expect(issued.some((s) => /FORCE ROW LEVEL SECURITY/i.test(s))).toBe(false);
  });

  // A table can have RLS enabled with NO policies at all — that is a deliberate
  // deny-all. Keying the enable off the policy list would silently drop it.
  it('enables RLS on a protected table that has no policies', async () => {
    const { source, dest, issued } = fakePools({
      policies: [],
      tableState: [{ tablename: 'locked_down', enabled: true, forced: false }],
    });
    await replayRls(source, dest, logger);
    expect(issued.some((s) => /ALTER TABLE "locked_down" ENABLE ROW LEVEL SECURITY/i.test(s))).toBe(true);
  });

  // Update runs against a LIVE fork. Disabling RLS is the one direction that
  // loosens security, so it must never be issued — even if the template has it
  // off and the fork has it on.
  it('never issues DISABLE or NO FORCE', async () => {
    const { source, dest, issued } = fakePools({
      policies: [policyRow],
      tableState: [{ tablename: 'secret_notes', enabled: false, forced: false }],
    });
    await replayRls(source, dest, logger);
    expect(issued.some((s) => /DISABLE ROW LEVEL SECURITY|NO FORCE/i.test(s))).toBe(false);
  });

  // Order matters on a live fork: flipping RLS on before the policies exist
  // means a window where every non-owner read returns nothing.
  it('creates policies before enabling RLS', async () => {
    const { source, dest, issued } = fakePools({
      policies: [policyRow],
      tableState: [{ tablename: 'secret_notes', enabled: true, forced: false }],
    });
    await replayRls(source, dest, logger);
    const createAt = issued.findIndex((s) => /CREATE POLICY/i.test(s));
    const enableAt = issued.findIndex((s) => /ENABLE ROW LEVEL SECURITY/i.test(s));
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(enableAt).toBeGreaterThan(createAt);
  });

  // A failed ENABLE is a SECURITY failure, not a cosmetic one: the table stays
  // readable. It must surface as a warning the job records, never be swallowed.
  it('warns when enabling RLS fails', async () => {
    const { source, dest } = fakePools({
      policies: [],
      tableState: [{ tablename: 'secret_notes', enabled: true, forced: false }],
      failOn: /ENABLE ROW LEVEL SECURITY/i,
    });
    const res = await replayRls(source, dest, logger);
    expect(res.warnings.join(' ')).toMatch(/secret_notes/);
    expect(res.warnings.join(' ')).toMatch(/row level security|RLS/i);
  });
});

// Enabling RLS on a table that carries a permissive `TO PUBLIC USING (true)`
// policy enforces nothing — the policies OR together and that one is always
// true. Forks cloned before the roles bug was fixed can carry exactly that,
// because the old replay turned every `TO butterbase_service USING (true)`
// bypass policy into a public one. Such a fork must not be left LOOKING
// protected: the replay reports it.
describe('replayRls neutered-policy detection', () => {
  it('warns when an enabled table has a permissive TO PUBLIC USING (true) policy', async () => {
    const issued: string[] = [];
    const source = {
      query: async (sql: string) => {
        if (/FROM pg_policies/i.test(sql)) return { rows: [] };
        if (/pg_class/i.test(sql)) return { rows: [{ tablename: 'notes', enabled: true, forced: false }] };
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    const dest = {
      query: async (sql: string) => {
        issued.push(sql);
        if (/pg_policies/i.test(sql)) {
          return { rows: [{ policyname: 'svc_bypass', tablename: 'notes' }] };
        }
        return { rows: [] };
      },
    } as unknown as pg.Pool;

    const res = await replayRls(source, dest, logger);
    expect(res.warnings.join(' ')).toMatch(/notes/);
    expect(res.warnings.join(' ')).toMatch(/svc_bypass/);
    expect(res.warnings.join(' ')).toMatch(/not enforced|no effect|bypass/i);
  });
});
