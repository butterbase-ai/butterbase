import { describe, it, expect } from 'vitest';
import { normalizeDefault } from '../services/schema-validator.js';
import { diffSchema } from '../services/schema-differ.js';
import type { IntrospectedSchema } from '../services/schema-introspector.js';
import type { SchemaDSL } from '../services/schema-validator.js';

describe('normalizeDefault', () => {
  it('equates DSL-quoted literal with Postgres canonical cast form', () => {
    expect(normalizeDefault("'pending'")).toBe(normalizeDefault("'pending'::text"));
    expect(normalizeDefault("'x'")).toBe(normalizeDefault("'x'::character varying"));
    expect(normalizeDefault("'{}'")).toBe(normalizeDefault("'{}'::jsonb"));
    expect(normalizeDefault("'2024-01-01'")).toBe(normalizeDefault("'2024-01-01'::date"));
  });

  it('preserves embedded single quotes (Postgres doubled-quote escape)', () => {
    expect(normalizeDefault("'it''s'::text")).toBe("'it''s'");
  });

  it('passes function-call and keyword defaults through unchanged', () => {
    expect(normalizeDefault('now()')).toBe('now()');
    expect(normalizeDefault('gen_random_uuid()')).toBe('gen_random_uuid()');
    expect(normalizeDefault('CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP');
    expect(normalizeDefault('true')).toBe('true');
    expect(normalizeDefault('0')).toBe('0');
  });

  it('leaves array-constructor casts intact (no leading string literal)', () => {
    expect(normalizeDefault('ARRAY[]::text[]')).toBe('ARRAY[]::text[]');
  });

  it('handles undefined', () => {
    expect(normalizeDefault(undefined)).toBeUndefined();
  });
});

describe('diffSchema default-change detection', () => {
  const desired: SchemaDSL = {
    tables: {
      todos: {
        columns: {
          id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
          status: { type: 'text', default: "'pending'" },
          tags: { type: 'jsonb', default: "'[]'" },
        },
      },
    },
  };

  function withCurrent(currentDefault: string | undefined): IntrospectedSchema {
    return {
      tables: {
        todos: {
          columns: {
            id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
            status: currentDefault === undefined
              ? { type: 'text' }
              : { type: 'text', default: currentDefault },
            tags: { type: 'jsonb', default: "'[]'::jsonb" },
          },
        },
      },
    };
  }

  it('does not emit SET DEFAULT when DSL literal matches PG-canonical cast form', () => {
    const stmts = diffSchema(withCurrent("'pending'::text"), desired);
    const setDefaults = stmts.filter((s) => s.sql.includes('SET DEFAULT'));
    expect(setDefaults).toEqual([]);
  });

  it('emits SET DEFAULT with the raw quoted literal when default actually changes', () => {
    const stmts = diffSchema(withCurrent("'archived'::text"), desired);
    const setDefaults = stmts.filter((s) => s.sql.includes('SET DEFAULT'));
    expect(setDefaults).toHaveLength(1);
    expect(setDefaults[0].sql).toContain("SET DEFAULT 'pending'");
    // The emitted DDL must be a valid Postgres expression (quoted literal),
    // NOT a bare token that PG would parse as a column reference.
    expect(setDefaults[0].sql).not.toMatch(/SET DEFAULT pending\b/);
  });

  it('emits SET DEFAULT when current column has no default', () => {
    const stmts = diffSchema(withCurrent(undefined), desired);
    const setDefaults = stmts.filter((s) => s.sql.includes('SET DEFAULT'));
    expect(setDefaults).toHaveLength(1);
    expect(setDefaults[0].sql).toContain("SET DEFAULT 'pending'");
  });
});
