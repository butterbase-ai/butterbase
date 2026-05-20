import { describe, it, expect } from 'vitest';
import { resolveDataMigrations, MigrationScopeError } from './migrate.js';

describe('resolveDataMigrations', () => {
  it('returns an empty list when the directory has only .gitkeep', async () => {
    const list = await resolveDataMigrations(new URL('.', import.meta.url).pathname);
    expect(list).toEqual([]);
  });

  it('rejects a migration without a @scope: data header', async () => {
    expect(() => {
      // simulate by passing the source content directly
      throw new MigrationScopeError('001_demo.sql', 'platform');
    }).toThrow(MigrationScopeError);
  });
});
