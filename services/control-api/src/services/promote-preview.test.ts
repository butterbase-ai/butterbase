import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ introspectSchema: vi.fn(), diffSchema: vi.fn() }));
// PARTIAL mock: only `introspectSchema` is stubbed. `describeMissing` — the
// pure schema comparison `computeIgnoredRemovals` delegates to, shared with
// staging-schema-reconcile.ts — must be the REAL one, or these tests would
// assert against a stub of the very logic they exist to check.
vi.mock('./schema-introspector.js', async (orig) => ({
  ...(await orig<typeof import('./schema-introspector.js')>()),
  introspectSchema: mocks.introspectSchema,
}));
vi.mock('./schema-differ.js', () => ({ diffSchema: mocks.diffSchema }));

import { buildPromotePreview, formatBlockedStatements, formatIgnoredRemovals } from './promote-preview.js';

const additive = { kind: 'create_table', sql: 'CREATE TABLE "notes" ()', destructive: false };
const dropCol = { kind: 'drop_column', sql: 'ALTER TABLE "notes" DROP COLUMN "old"', destructive: true };

const notesTable = {
  columns: {
    id: { type: 'uuid', primaryKey: true },
    title: { type: 'text' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.introspectSchema.mockResolvedValue({ tables: {} });
});

describe('buildPromotePreview', () => {
  it('allows a promote when every statement is additive', async () => {
    mocks.diffSchema.mockReturnValue([additive]);
    const preview = await buildPromotePreview({} as never, {} as never);
    expect(preview.canPromote).toBe(true);
    expect(preview.additive).toHaveLength(1);
    expect(preview.blocked).toHaveLength(0);
  });

  it('refuses a promote that needs a destructive statement', async () => {
    mocks.diffSchema.mockReturnValue([additive, dropCol]);
    const preview = await buildPromotePreview({} as never, {} as never);
    expect(preview.canPromote).toBe(false);
    expect(preview.blocked.map((s) => s.sql)).toEqual([dropCol.sql]);
  });

  it('allows an empty diff — promote of config-only changes is still valid', async () => {
    mocks.diffSchema.mockReturnValue([]);
    expect((await buildPromotePreview({} as never, {} as never)).canPromote).toBe(true);
  });

  it('diffs staging against production, not the reverse', async () => {
    const prodSchema = { tables: { prod: notesTable } };
    const stagingSchema = { tables: { staging: notesTable } };
    mocks.introspectSchema
      .mockResolvedValueOnce(prodSchema)
      .mockResolvedValueOnce(stagingSchema);
    mocks.diffSchema.mockReturnValue([]);
    await buildPromotePreview({} as never, {} as never);
    expect(mocks.diffSchema).toHaveBeenCalledWith(prodSchema, stagingSchema);
  });

  it('reports a column dropped in staging as an ignored removal, not a blocker', async () => {
    mocks.introspectSchema
      .mockResolvedValueOnce({ tables: { notes: notesTable } })
      .mockResolvedValueOnce({
        tables: { notes: { columns: { id: notesTable.columns.id } } },
      });
    mocks.diffSchema.mockReturnValue([]);
    const preview = await buildPromotePreview({} as never, {} as never);
    expect(preview.ignoredRemovals).toEqual(['column "notes"."title"']);
    expect(preview.canPromote).toBe(true);
  });

  it('reports a table dropped in staging as an ignored removal', async () => {
    mocks.introspectSchema
      .mockResolvedValueOnce({ tables: { notes: notesTable } })
      .mockResolvedValueOnce({ tables: {} });
    mocks.diffSchema.mockReturnValue([]);
    const preview = await buildPromotePreview({} as never, {} as never);
    expect(preview.ignoredRemovals).toEqual(['table "notes"']);
  });

  it('reports no ignored removals for identical schemas', async () => {
    mocks.introspectSchema
      .mockResolvedValueOnce({ tables: { notes: notesTable } })
      .mockResolvedValueOnce({ tables: { notes: notesTable } });
    mocks.diffSchema.mockReturnValue([]);
    const preview = await buildPromotePreview({} as never, {} as never);
    expect(preview.ignoredRemovals).toEqual([]);
  });
});

describe('formatBlockedStatements', () => {
  it('names every blocked statement', () => {
    const msg = formatBlockedStatements([dropCol]);
    expect(msg).toContain('DROP COLUMN "old"');
  });

  it('explains why, not just what', () => {
    expect(formatBlockedStatements([dropCol])).toMatch(/would destroy production data/i);
  });
});

describe('formatIgnoredRemovals', () => {
  it('names the ignored removal and says it will not be applied', () => {
    const msg = formatIgnoredRemovals(['column "notes"."title"']);
    expect(msg).toContain('column "notes"."title"');
    expect(msg).toMatch(/will not be applied/i);
  });
});
