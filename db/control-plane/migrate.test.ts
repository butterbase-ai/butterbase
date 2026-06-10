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

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('migrations', () => {
  it('088_app_meetings_webhooks has correct column schema', async () => {
    const dbUrl = process.env.TEST_DATABASE_URL;
    if (!dbUrl) {
      console.warn('TEST_DATABASE_URL not set, skipping database test');
      return;
    }

    const pool = new pg.Pool({ connectionString: dbUrl });
    const client = await pool.connect();
    try {
      // Load and apply the migration
      const migrationPath = path.join(__dirname, '088_app_meetings_webhooks.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      // Skip the @scope comment line and apply the rest
      const sqlLines = migrationSql.split('\n').filter(line => !line.startsWith('-- @scope'));
      await client.query(sqlLines.join('\n'));

      // Query the columns from information_schema
      const { rows } = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'app_meetings_webhooks'
        ORDER BY ordinal_position
      `);

      const columnNames = rows.map(row => row.column_name).sort();
      expect(columnNames).toEqual([
        'app_id',
        'created_at',
        'events',
        'forward_secret_hash',
        'forward_url',
        'updated_at',
      ]);
    } finally {
      client.release();
      await pool.end();
    }
  });
});
