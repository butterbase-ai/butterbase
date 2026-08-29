import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { applyMigration } from '../services/schema-applier.js';

function fakePool() {
  const executed: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      executed.push(sql);
      if (/RETURNING id/i.test(sql)) return { rows: [{ id: 1 }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, executed };
}

describe('applyMigration authorization', () => {
  it('refuses an unauthorized destructive statement', async () => {
    const { pool, executed } = fakePool();
    await expect(applyMigration(pool, [
      { sql: 'DROP TABLE "x" CASCADE', description: 'drop', destructive: true, authorized: false },
    ], 'test')).rejects.toThrow(/unauthorized destructive/i);
    expect(executed).not.toContain('DROP TABLE "x" CASCADE');
  });

  it('still runs authorized destructive statements', async () => {
    const { pool, executed } = fakePool();
    await applyMigration(pool, [
      { sql: 'DROP TABLE "y" CASCADE', description: 'drop', destructive: true, authorized: true },
    ], 'test');
    expect(executed).toContain('DROP TABLE "y" CASCADE');
  });
});
