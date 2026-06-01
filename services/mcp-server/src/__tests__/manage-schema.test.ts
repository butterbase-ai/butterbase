import { describe, it, expect } from 'vitest';
import { ManageSchemaInput } from '../tools/manage-schema.js';

describe('manage_schema regression — _seed: true on table input survives Zod parse', () => {
  it('preserves table-level _seed: true', () => {
    const parsed = ManageSchemaInput.parse({
      app_id: 'app_test',
      action: 'apply',
      schema: {
        tables: {
          foo: {
            _seed: true,
            columns: { id: { type: 'uuid', primaryKey: true } },
          },
        },
      },
    });
    expect((parsed.schema?.tables?.foo as any)._seed).toBe(true);
  });

  it('preserves table-level _seed: false', () => {
    const parsed = ManageSchemaInput.parse({
      app_id: 'app_test',
      action: 'apply',
      schema: {
        tables: {
          bar: {
            _seed: false,
            columns: { id: { type: 'uuid', primaryKey: true } },
          },
        },
      },
    });
    expect((parsed.schema?.tables?.bar as any)._seed).toBe(false);
  });

  it('omits _seed when not provided', () => {
    const parsed = ManageSchemaInput.parse({
      app_id: 'app_test',
      action: 'apply',
      schema: {
        tables: {
          baz: {
            columns: { id: { type: 'uuid', primaryKey: true } },
          },
        },
      },
    });
    expect((parsed.schema?.tables?.baz as any)._seed).toBeUndefined();
  });
});
