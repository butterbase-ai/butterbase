import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ introspectSchema: vi.fn(), diffSchema: vi.fn() }));
vi.mock('./schema-introspector.js', () => ({ introspectSchema: mocks.introspectSchema }));
vi.mock('./schema-differ.js', () => ({ diffSchema: mocks.diffSchema }));

import { buildPromotePreview, formatBlockedStatements } from './promote-preview.js';

const additive = { kind: 'create_table', sql: 'CREATE TABLE "notes" ()', destructive: false };
const dropCol = { kind: 'drop_column', sql: 'ALTER TABLE "notes" DROP COLUMN "old"', destructive: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.introspectSchema.mockResolvedValue({ tables: [] });
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
    mocks.introspectSchema
      .mockResolvedValueOnce({ tables: ['prod'] })
      .mockResolvedValueOnce({ tables: ['staging'] });
    mocks.diffSchema.mockReturnValue([]);
    await buildPromotePreview({} as never, {} as never);
    expect(mocks.diffSchema).toHaveBeenCalledWith({ tables: ['prod'] }, { tables: ['staging'] });
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
