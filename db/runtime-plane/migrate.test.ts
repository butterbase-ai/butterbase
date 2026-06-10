import { describe, it, expect } from 'vitest';
import { resolveRuntimeUrls, MigrationScopeError } from './migrate.js';

describe('resolveRuntimeUrls', () => {
  it('returns one URL per region from env', () => {
    expect(
      resolveRuntimeUrls(['us-east-1', 'eu-west-1'], {
        NEON_RUNTIME_PROJECT_ID_US_EAST_1: 'postgres://us',
        NEON_RUNTIME_PROJECT_ID_EU_WEST_1: 'postgres://eu',
      })
    ).toEqual({ 'us-east-1': 'postgres://us', 'eu-west-1': 'postgres://eu' });
  });

  it('throws when a region has no env var', () => {
    expect(() =>
      resolveRuntimeUrls(['us-east-1', 'eu-west-1'], {
        NEON_RUNTIME_PROJECT_ID_US_EAST_1: 'postgres://us',
      })
    ).toThrow(/NEON_RUNTIME_PROJECT_ID_EU_WEST_1/);
  });
});

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('migrations', () => {
  it('023_actor_usage_logs has correct column schema', async () => {
    const dbUrl = process.env.TEST_DATABASE_URL;
    if (!dbUrl) {
      console.warn('TEST_DATABASE_URL not set, skipping database test');
      return;
    }

    const pool = new pg.Pool({ connectionString: dbUrl });
    const client = await pool.connect();
    try {
      // Load and apply the migration
      const migrationPath = path.join(__dirname, '023_actor_usage_logs.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      // Skip the @scope comment line and apply the rest
      const sqlLines = migrationSql.split('\n').filter(line => !line.startsWith('-- @scope'));
      await client.query(sqlLines.join('\n'));

      // Query the columns from information_schema
      const { rows } = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'actor_usage_logs'
        ORDER BY ordinal_position
      `);

      const columnNames = rows.map(row => row.column_name);
      expect(columnNames).toEqual([
        'id',
        'created_at',
        'app_id',
        'user_id',
        'provider_key',
        'actor_id',
        'dimension',
        'seconds',
        'usd_cost',
        'usd_charged',
        'markup_pct',
        'lease_id',
        'request_metadata',
      ]);
    } finally {
      client.release();
      await pool.end();
    }
  });
});
