import { describe, it, expect } from 'vitest';
import { parseIndexDef } from '../services/schema-introspector.js';

describe('parseIndexDef', () => {
  it('strips surrounding quotes from reserved-word column names', () => {
    // Regression: Postgres quotes reserved words like `position` in indexdef.
    // Storing `"position"` (with quotes) then re-quoting in the differ produced
    // `""position""`, which Postgres rejected as a zero-length delimited
    // identifier during clone replay. See cj_ZuBtVX7dRxaCRf83-W9tgmXN.
    const def =
      'CREATE INDEX custom_fields_ws_obj_idx ON public.custom_fields USING btree (workspace_id, object_type, "position")';
    expect(parseIndexDef(def)).toEqual({
      columns: ['workspace_id', 'object_type', 'position'],
    });
  });

  it('unescapes embedded double-quotes inside a quoted identifier', () => {
    const def = 'CREATE INDEX t_idx ON public.t USING btree ("weird""name")';
    expect(parseIndexDef(def)).toEqual({ columns: ['weird"name'] });
  });

  it('parses plain unquoted column names', () => {
    const def = 'CREATE INDEX t_idx ON public.t USING btree (a, b, c)';
    expect(parseIndexDef(def)).toEqual({ columns: ['a', 'b', 'c'] });
  });

  it('flags UNIQUE indexes', () => {
    const def = 'CREATE UNIQUE INDEX t_idx ON public.t USING btree (a)';
    expect(parseIndexDef(def)).toEqual({ columns: ['a'], unique: true });
  });

  it('records non-btree access method', () => {
    const def =
      'CREATE INDEX t_idx ON public.t USING gin (tags)';
    expect(parseIndexDef(def)).toEqual({ columns: ['tags'], method: 'gin' });
  });

  it('captures opclass alongside the column', () => {
    const def =
      'CREATE INDEX t_idx ON public.t USING hnsw (embedding vector_cosine_ops)';
    expect(parseIndexDef(def)).toEqual({
      columns: ['embedding'],
      method: 'hnsw',
      opclass: 'vector_cosine_ops',
    });
  });

  it('returns null for unparseable indexdef', () => {
    expect(parseIndexDef('garbage')).toBeNull();
  });
});
