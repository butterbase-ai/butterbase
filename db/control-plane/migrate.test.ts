import { describe, it, expect } from 'vitest';
import { parseScopeHeader, MigrationScopeError, applyByScope } from './migrate.js';

describe('parseScopeHeader', () => {
  it('parses platform scope', () => {
    expect(parseScopeHeader('-- @scope: platform\nCREATE TABLE x();')).toEqual('platform');
  });

  it('parses runtime scope', () => {
    expect(parseScopeHeader('-- @scope: runtime\nCREATE TABLE x();')).toEqual('runtime');
  });

  it('parses data scope', () => {
    expect(parseScopeHeader('-- @scope: data\nCREATE TABLE x();')).toEqual('data');
  });

  it('tolerates leading whitespace and trailing whitespace on the line', () => {
    expect(parseScopeHeader('  -- @scope:   platform  \n')).toEqual('platform');
  });

  it('throws when header is missing', () => {
    expect(() => parseScopeHeader('CREATE TABLE x();')).toThrow(MigrationScopeError);
    expect(() => parseScopeHeader('CREATE TABLE x();')).toThrow(/@scope/);
  });

  it('throws when scope value is invalid', () => {
    expect(() => parseScopeHeader('-- @scope: bogus\n')).toThrow(/Invalid scope "bogus"/);
  });

  it('requires the header to be on the first non-blank line', () => {
    expect(() => parseScopeHeader('CREATE TABLE x();\n-- @scope: platform\n')).toThrow(MigrationScopeError);
  });
});

import { applyByScope } from './migrate.js';

describe('applyByScope', () => {
  // For runtime/data tests we use a stub client that fails the test if it's touched.
  const failingClient = {
    query() {
      throw new Error('client should not be touched for runtime/data scopes');
    },
  } as any;

  it('throws not-implemented error for runtime scope without touching DB', async () => {
    await expect(
      applyByScope('runtime', 'demo.sql', '-- @scope: runtime\n', failingClient)
    ).rejects.toThrow(/runtime tier is not implemented until Phase 2/);
  });

  it('throws not-implemented error for data scope without touching DB', async () => {
    await expect(
      applyByScope('data', 'demo.sql', '-- @scope: data\n', failingClient)
    ).rejects.toThrow(/data DB routing is not implemented until Phase 4/);
  });

  it('the runtime error message names the offending file', async () => {
    await expect(
      applyByScope('runtime', '042_some_migration.sql', '-- @scope: runtime\n', failingClient)
    ).rejects.toThrow(/042_some_migration\.sql/);
  });
});
