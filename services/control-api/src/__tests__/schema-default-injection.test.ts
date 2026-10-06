import { describe, it, expect } from 'vitest';
import { isSafeColumnDefault, isSafeOpclass, SchemaDSLSchema } from '../services/schema-validator.js';
import { diffSchema } from '../services/schema-differ.js';

// `default` and `opclass` were bare z.string() while type / table / column all
// had patterns, and all four are interpolated straight into DDL. Statements run
// via client.query(sql) with no params, which is Postgres's SIMPLE query
// protocol — it happily executes `;`-chained statements. So a crafted default
// ran arbitrary SQL inside the migration transaction.
//
// The template-update path made that cross-tenant: a template owner could ship
// a payload that executes on every fork applying an update. filterAdditive only
// rejects destructive DDL *kinds*, so a non-DROP payload (UPDATE, INSERT, COPY,
// GRANT) sailed through it.
describe('isSafeColumnDefault — accepts the real-world forms', () => {
  const good = [
    "gen_random_uuid()",
    "now()",
    "uuid_generate_v4()",
    "CURRENT_TIMESTAMP",
    "current_timestamp",
    "CURRENT_DATE",
    "LOCALTIMESTAMP",
    "true",
    "false",
    "TRUE",
    "null",
    "0",
    "-1",
    "3.14",
    "1e5",
    "'pending'",
    "''",
    "'[]'",
    "'[]'::jsonb",
    "'{}'::jsonb",
    "'{}'::text[]",
    "'x''y'",              // doubled quote is the SQL escape, not a break-out
    "nextval('my_seq')",
    "now()::timestamptz",
    "0::numeric(10,2)",
    "  'padded'  ",        // surrounding whitespace is fine
  ];
  for (const d of good) {
    it(`accepts ${JSON.stringify(d)}`, () => {
      expect(isSafeColumnDefault(d)).toBe(true);
    });
  }
});

describe('isSafeColumnDefault — rejects injection', () => {
  const bad: [string, string][] = [
    ["'x'; DROP TABLE users; --", 'statement chaining'],
    ["'x'; UPDATE members SET role='admin'; --", 'non-destructive payload filterAdditive would miss'],
    ["'x'--", 'line comment'],
    ["'x'/* c */", 'block comment'],
    ["$$; DROP TABLE t; $$", 'dollar quoting'],
    ["'unterminated", 'unbalanced quote'],
    ["'a' || (SELECT password FROM secrets LIMIT 1)", 'subselect'],
    ["(SELECT 1)", 'bare subselect'],
    ["pg_read_file('/etc/passwd')", 'non-allowlisted function'],
    ["gen_random_uuid(); DROP TABLE t", 'chaining after a legitimate call'],
    ["1; COPY t FROM PROGRAM 'sh -c id'", 'COPY FROM PROGRAM'],
  ];
  for (const [d, why] of bad) {
    it(`rejects ${why}: ${JSON.stringify(d)}`, () => {
      expect(isSafeColumnDefault(d)).toBe(false);
    });
  }
});

describe('isSafeOpclass', () => {
  it('accepts a plain operator class', () => {
    expect(isSafeOpclass('vector_cosine_ops')).toBe(true);
    expect(isSafeOpclass('gin_trgm_ops')).toBe(true);
  });
  it('rejects anything that is not a bare identifier', () => {
    expect(isSafeOpclass('ops) ; DROP TABLE t; --')).toBe(false);
    expect(isSafeOpclass('a b')).toBe(false);
    expect(isSafeOpclass('"quoted"')).toBe(false);
  });
});

// The validator is the gate the routes actually call, so the rejection has to
// happen there — not only in the helper.
describe('SchemaDSLSchema rejects an injected default', () => {
  it('throws on a chained-statement default', () => {
    expect(() => SchemaDSLSchema.parse({
      tables: {
        t: { columns: { c: { type: 'text', default: "'x'; DROP TABLE users; --" } } },
      },
    })).toThrow();
  });

  it('still accepts a legitimate schema', () => {
    expect(() => SchemaDSLSchema.parse({
      tables: {
        t: {
          columns: {
            id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
            status: { type: 'text', default: "'pending'" },
            meta: { type: 'jsonb', default: "'{}'::jsonb" },
          },
        },
      },
    })).not.toThrow();
  });

  it('rejects an injected index opclass', () => {
    expect(() => SchemaDSLSchema.parse({
      tables: {
        t: {
          columns: { c: { type: 'text' } },
          indexes: { i: { columns: ['c'], opclass: 'ops); DROP TABLE users; --' } },
        },
      },
    })).toThrow();
  });
});

// End-to-end: a validated schema must never produce DDL containing a statement
// separator. This is the property that actually matters.
describe('diffSchema never emits chained statements from a validated schema', () => {
  it('emits one statement per DDL action, no embedded semicolons', () => {
    const desired = SchemaDSLSchema.parse({
      tables: {
        t: {
          columns: {
            id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
            status: { type: 'text', default: "'pending'" },
          },
        },
      },
    });
    const stmts = diffSchema({ tables: {} }, desired as never);
    for (const s of stmts) {
      expect(s.sql.replace(/;\s*$/, '')).not.toContain(';');
    }
  });
});

// Every DEFAULT actually present on butterbase-crm (29 tables, 34 forks), read
// out of `manage_schema get` on 2026-09-02. These are the introspected,
// Postgres-canonicalised forms that round-trip through `manage_schema apply`,
// so rejecting any of them breaks a live app. The first cut of this validator
// was a regex and it rejected the interval expression below.
describe('isSafeColumnDefault — real defaults from a live 29-table template', () => {
  const live = [
    "gen_random_uuid()",
    "now()",
    "true",
    "false",
    "0",
    "25",
    "180",
    "'pending'::text",
    "'copilot'::text",
    "'active'::text",
    "'member'::text",
    "'draft'::text",
    "'queued'::text",
    "'gmail'::text",
    "'people'::text",
    "'manual'::text",
    "'lead'::text",
    "'Notetaker'::text",
    "'{}'::jsonb",
    "'[]'::jsonb",
    "(now() + '24:00:00'::interval)",
    "'[\"industry\", \"description\", \"linkedin_url\"]'::jsonb",
    "'[\"title\", \"linkedin_url\"]'::jsonb",
  ];
  for (const d of live) {
    it(`accepts live default ${JSON.stringify(d)}`, () => {
      expect(isSafeColumnDefault(d)).toBe(true);
    });
  }
});

// The tokenizer is more permissive than the first regex (it has to be), so
// re-assert the dangerous shapes against the shape it actually accepts.
describe('isSafeColumnDefault — tokenizer still refuses execution', () => {
  const bad = [
    "(now() + '1 day'::interval); DROP TABLE t",
    "now() || (SELECT 1)",
    "(SELECT password FROM secrets)",
    "COALESCE((SELECT 1), 2)",
    "some_column",
    "pg_sleep(10)",
    "'a' -- x",
    "(unbalanced",
    "1 +",
  ];
  for (const d of bad) {
    it(`rejects ${JSON.stringify(d)}`, () => {
      expect(isSafeColumnDefault(d)).toBe(false);
    });
  }
});

// Distinct forms from butter-support (20 tables, 20 forks), same date.
describe('isSafeColumnDefault — real defaults from the second live template', () => {
  const live = [
    "'draft_for_approval'::text",
    "'med'::text",
    "'warn'::text",
    "'widget'::text",
    "'open'::text",
    "'idle'::text",
    "'normal'::text",
    "1",
    "'{}'::text[]",
  ];
  for (const d of live) {
    it(`accepts live default ${JSON.stringify(d)}`, () => {
      expect(isSafeColumnDefault(d)).toBe(true);
    });
  }
});
