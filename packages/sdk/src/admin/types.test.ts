import { describe, it, expect } from 'vitest';
import type { SchemaDefinition, SchemaTable } from './types';

describe('SchemaDefinition', () => {
  it('supports _drop at top level', () => {
    const s: SchemaDefinition = {
      tables: { posts: { columns: { id: { type: 'uuid' } } } },
      _drop: ['legacy_table'],
    };
    expect(s._drop).toEqual(['legacy_table']);
  });

  it('SchemaTable supports _dropColumns', () => {
    const t: SchemaTable = {
      columns: { id: { type: 'uuid' } },
      _dropColumns: ['deprecated_col'],
    };
    expect(t._dropColumns).toEqual(['deprecated_col']);
  });

  it('all destructive ops are optional', () => {
    const s: SchemaDefinition = { tables: {} };
    expect(s._drop).toBeUndefined();
  });
});
