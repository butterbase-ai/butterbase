import { describe, it, expect } from 'vitest';
import { resolveRuntimeUrls, MigrationScopeError, parseScopeHeader } from './migrate.js';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const skipDb = !process.env.TEST_DATABASE_URL;

describe.skipIf(skipDb)('migrations', () => {
  it('023_actor_usage_logs has correct column schema', async () => {
    const dbUrl = process.env.TEST_DATABASE_URL!;
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

  it('applies 029 ai_responses table', async () => {
    const dbUrl = process.env.TEST_DATABASE_URL!;
    const pool = new pg.Pool({ connectionString: dbUrl });
    const client = await pool.connect();
    try {
      // Load and apply the migration
      const migrationPath = path.join(__dirname, '029_ai_responses.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

      // Skip the @scope comment line and apply the rest
      const sqlLines = migrationSql.split('\n').filter(line => !line.startsWith('-- @scope'));
      await client.query(sqlLines.join('\n'));

      // Verify table exists
      const res = await client.query(`SELECT to_regclass('ai_responses') as t`);
      expect(res.rows[0].t).toBe('ai_responses');

      // Query the columns from information_schema
      const { rows } = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ai_responses'
        ORDER BY column_name
      `);

      const columnNames = rows.map(row => row.column_name);
      expect(columnNames).toEqual(
        expect.arrayContaining(['id', 'created_at', 'previous_response_id', 'model',
                                'input_messages', 'output', 'usage', 'status', 'expires_at'])
      );
    } finally {
      client.release();
      await pool.end();
    }
  });
});

describe('034_apps_organization_id migration', () => {
  const migrationPath = path.join(__dirname, '034_apps_organization_id.sql');
  const sql = fs.readFileSync(migrationPath, 'utf-8');

  it('has a valid runtime scope header', () => {
    expect(parseScopeHeader(sql)).toEqual('runtime');
  });

  it('adds nullable organization_id to apps', () => {
    expect(sql).toMatch(/ALTER TABLE apps[\s\S]+ADD COLUMN IF NOT EXISTS organization_id\s+uuid/i);
  });

  it('does NOT add a foreign key (cross-plane logical ref only)', () => {
    expect(sql).not.toMatch(/REFERENCES\s+organizations/i);
  });

  it('creates a (organization_id, created_at DESC) index', () => {
    expect(sql).toMatch(/CREATE INDEX[\s\S]+apps[\s\S]+\(organization_id[^)]*created_at\s+DESC\)/i);
  });
});

describe('035_apps_substrate_organization_id migration', () => {
  const migrationPath = path.join(__dirname, '035_apps_substrate_organization_id.sql');

  it('has a valid runtime scope header', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(parseScopeHeader(sql)).toEqual('runtime');
  });

  it('adds nullable substrate_organization_id on apps', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/ALTER TABLE\s+apps[\s\S]+ADD COLUMN[\s\S]+substrate_organization_id\s+uuid/i);
  });

  it('adds partial index on substrate_organization_id', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/CREATE INDEX[\s\S]+apps_substrate_org_id_idx[\s\S]+apps[\s\S]+\(substrate_organization_id\)[\s\S]+WHERE substrate_organization_id IS NOT NULL/i);
  });
});

describe('036_usage_meters_organization_id migration', () => {
  const migrationPath = path.join(__dirname, '036_usage_meters_organization_id.sql');

  it('has a valid runtime scope header', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(parseScopeHeader(sql)).toEqual('runtime');
  });

  it('adds nullable organization_id on usage_meters (no FK - cross-plane)', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/ALTER TABLE\s+usage_meters[\s\S]+ADD COLUMN[\s\S]+organization_id\s+uuid/i);
    // Explicitly assert NO REFERENCES clause on the column add
    expect(sql).not.toMatch(/organization_id\s+uuid[\s\S]{0,50}REFERENCES/i);
  });

  it('adds partial index', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/CREATE INDEX[\s\S]+usage_meters_organization_id_idx[\s\S]+usage_meters[\s\S]+\(organization_id\)[\s\S]+WHERE organization_id IS NOT NULL/i);
  });
});

describe('037_ai_and_actor_logs_organization_id migration', () => {
  const migrationPath = path.join(__dirname, '037_ai_and_actor_logs_organization_id.sql');
  const TABLES = ['ai_usage_logs', 'actor_usage_logs', 'ai_video_jobs'];

  it('has a valid runtime scope header', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(parseScopeHeader(sql)).toEqual('runtime');
  });

  it('adds nullable organization_id on all 3 tables', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    for (const t of TABLES) {
      expect(sql, `${t} missing`).toMatch(new RegExp(
        `ALTER TABLE\\s+${t}[\\s\\S]+ADD COLUMN[\\s\\S]+organization_id\\s+uuid`,
        'i',
      ));
    }
  });

  it('adds partial index per table', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    for (const t of TABLES) {
      expect(sql, `${t} missing index`).toMatch(new RegExp(
        `CREATE INDEX[\\s\\S]+${t}_organization_id_idx[\\s\\S]+${t}[\\s\\S]+\\(organization_id\\)`,
        'i',
      ));
    }
  });
});

describe('038_storage_and_proxy_organization_id migration', () => {
  const migrationPath = path.join(__dirname, '038_storage_and_proxy_organization_id.sql');
  const TABLES = ['storage_objects', 'mcp_tool_call_log', 'partner_proxy_logs'];

  it('has a valid runtime scope header', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(parseScopeHeader(sql)).toEqual('runtime');
  });

  it('adds nullable organization_id on all 3 tables', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    for (const t of TABLES) {
      expect(sql, `${t} missing`).toMatch(new RegExp(
        `ALTER TABLE\\s+${t}[\\s\\S]+ADD COLUMN[\\s\\S]+organization_id\\s+uuid`,
        'i',
      ));
    }
  });

  it('adds partial index per table', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    for (const t of TABLES) {
      expect(sql, `${t} missing index`).toMatch(new RegExp(
        `CREATE INDEX[\\s\\S]+${t}_organization_id_idx[\\s\\S]+${t}[\\s\\S]+\\(organization_id\\)`,
        'i',
      ));
    }
  });
});

describe('039_app_enduser_organization_id migration', () => {
  const migrationPath = path.join(__dirname, '039_app_enduser_organization_id.sql');
  const TABLES = ['app_refresh_tokens', 'app_verification_codes', 'app_subscriptions', 'app_orders'];

  it('has a valid runtime scope header', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(parseScopeHeader(sql)).toEqual('runtime');
  });

  it('adds nullable organization_id on all 4 tables', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    for (const t of TABLES) {
      expect(sql, `${t} missing`).toMatch(new RegExp(
        `ALTER TABLE\\s+${t}[\\s\\S]+ADD COLUMN[\\s\\S]+organization_id\\s+uuid`,
        'i',
      ));
    }
  });

  it('adds partial index per table', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    for (const t of TABLES) {
      expect(sql, `${t} missing index`).toMatch(new RegExp(
        `CREATE INDEX[\\s\\S]+${t}_organization_id_idx[\\s\\S]+${t}[\\s\\S]+\\(organization_id\\)`,
        'i',
      ));
    }
  });
});

describe('040_people_organization_id migration', () => {
  const migrationPath = path.join(__dirname, '040_people_organization_id.sql');
  const TABLES = ['people_email_lookups', 'people_usage_logs'];

  it('has a valid runtime scope header', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(parseScopeHeader(sql)).toEqual('runtime');
  });

  it('adds nullable organization_id on all existing people-related tables', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    for (const t of TABLES) {
      expect(sql, `${t} missing`).toMatch(new RegExp(
        `ALTER TABLE\\s+${t}[\\s\\S]+ADD COLUMN[\\s\\S]+organization_id\\s+uuid`,
        'i',
      ));
    }
  });

  it('adds partial index per table', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    for (const t of TABLES) {
      expect(sql, `${t} missing index`).toMatch(new RegExp(
        `CREATE INDEX[\\s\\S]+${t}_organization_id_idx[\\s\\S]+${t}[\\s\\S]+\\(organization_id\\)`,
        'i',
      ));
    }
  });
});

describe('041_remaining_org_id_not_null migration', () => {
  const migrationPath = path.join(__dirname, '041_remaining_org_id_not_null.sql');
  const TABLES = [
    'usage_meters',
    'ai_usage_logs', 'actor_usage_logs', 'ai_video_jobs',
    'storage_objects', 'mcp_tool_call_log', 'partner_proxy_logs',
    'app_refresh_tokens', 'app_verification_codes', 'app_subscriptions', 'app_orders',
    'people_email_lookups', 'people_usage_logs',
  ];

  it('has a valid runtime scope header', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(parseScopeHeader(sql)).toEqual('runtime');
  });

  it('flips organization_id to NOT NULL on all 13 tables', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    for (const t of TABLES) {
      expect(sql, `${t} missing`).toMatch(new RegExp(
        `ALTER TABLE\\s+${t}[\\s\\S]+ALTER COLUMN\\s+organization_id\\s+SET NOT NULL`,
        'i',
      ));
    }
  });

  it('does NOT drop or rename any column', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/RENAME COLUMN/i);
  });
});
