import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseScopeHeader,
  MigrationScopeError,
  applyByScope,
  parsePhaseHeader,
  MigrationPhaseError,
  planMigrations,
  logSkippedPostDeploy,
  ALLOW_POST_DEPLOY_ENV_VAR,
} from './migrate.js';

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

  it('throws misplaced-migration error for runtime scope without touching DB', async () => {
    await expect(
      applyByScope('runtime', 'demo.sql', '-- @scope: runtime\n', failingClient)
    ).rejects.toThrow(/scope=runtime but it is under db\/control-plane\//);
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

describe('every control-plane migration declares a scope', () => {
  // Guard for a defect that already shipped once: migrations 098-101 were
  // committed without the `-- @scope:` header. migrate.ts THROWS on a missing
  // header instead of skipping the file, and the throw is outside the loop's
  // try, so a single header-less file aborts the entire run — every migration
  // after it silently never applies. A fresh dev/self-host DB got none of them.
  //
  // This test globs the directory rather than listing filenames so a new
  // migration cannot be added without a header.
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.oss-only'))
    .sort();

  it('finds migration files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s declares @scope: platform on its first non-blank line', (file) => {
    // Asserting merely that a scope is DECLARED (via not.toThrow()) lets a
    // future file headed `-- @scope: runtime` or `-- @scope: data` pass this
    // guard — but applyByScope() THROWS for those scopes when run from
    // db/control-plane/ (they belong under db/runtime-plane/, or aren't
    // implemented yet), and that throw is uncaught by the migration loop,
    // aborting the whole run and silently skipping every migration after it.
    // Every file directly under db/control-plane/ must declare exactly
    // 'platform', not merely "some valid value".
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    expect(parseScopeHeader(sql)).toEqual('platform');
  });
});

describe('parsePhaseHeader', () => {
  it('defaults to pre-deploy when no @phase header is present', () => {
    expect(parsePhaseHeader('-- @scope: platform\nCREATE TABLE x();')).toEqual('pre-deploy');
  });

  it('parses @phase: post-deploy from the header comment block', () => {
    expect(
      parsePhaseHeader('-- @scope: platform\n-- @phase: post-deploy\nCREATE TABLE x();')
    ).toEqual('post-deploy');
  });

  it('does not require @phase to be on the first line (that is @scope’s)', () => {
    const sql = [
      '-- @scope: platform',
      '-- some prose',
      '-- more prose',
      '-- @phase: post-deploy',
      '-- trailing prose',
      '',
      'ALTER TABLE x DROP COLUMN y;',
    ].join('\n');
    expect(parsePhaseHeader(sql)).toEqual('post-deploy');
  });

  it('stops scanning at the first non-comment, non-blank line', () => {
    const sql = [
      '-- @scope: platform',
      'ALTER TABLE x DROP COLUMN y;',
      '-- @phase: post-deploy (this is now SQL-adjacent prose, not a header)',
    ].join('\n');
    expect(parsePhaseHeader(sql)).toEqual('pre-deploy');
  });

  it('throws on an invalid phase value', () => {
    expect(() => parsePhaseHeader('-- @scope: platform\n-- @phase: sometime\n')).toThrow(
      MigrationPhaseError
    );
    expect(() => parsePhaseHeader('-- @scope: platform\n-- @phase: sometime\n')).toThrow(
      /Invalid phase "sometime"/
    );
  });
});

describe('planMigrations / post-deploy phase gating', () => {
  const preDeployFile = { file: '098_pre.sql', sql: '-- @scope: platform\nSELECT 1;' };
  const postDeployFile = {
    file: '103_post.sql',
    sql: '-- @scope: platform\n-- @phase: post-deploy\nSELECT 1;',
  };

  it('skips a post-deploy file by default (env var unset)', () => {
    const { toApply, skipped } = planMigrations([preDeployFile, postDeployFile], false);
    expect(toApply.map((e) => e.file)).toEqual(['098_pre.sql']);
    expect(skipped.map((e) => e.file)).toEqual(['103_post.sql']);
  });

  it('applies the post-deploy file when the opt-in flag is true', () => {
    const { toApply, skipped } = planMigrations([preDeployFile, postDeployFile], true);
    expect(toApply.map((e) => e.file)).toEqual(['098_pre.sql', '103_post.sql']);
    expect(skipped).toEqual([]);
  });

  it('always applies an unmarked (pre-deploy) file, regardless of the flag', () => {
    for (const allow of [false, true]) {
      const { toApply, skipped } = planMigrations([preDeployFile], allow);
      expect(toApply.map((e) => e.file)).toEqual(['098_pre.sql']);
      expect(skipped).toEqual([]);
    }
  });

  it(`the env var name is ${ALLOW_POST_DEPLOY_ENV_VAR}`, () => {
    // Locks the exact name so migrate.ts and any operator-facing docs/log
    // messages can't drift from each other silently.
    expect(ALLOW_POST_DEPLOY_ENV_VAR).toEqual('ALLOW_POST_DEPLOY_MIGRATIONS');
  });
});

describe('logSkippedPostDeploy', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('logs nothing when nothing was skipped', () => {
    logSkippedPostDeploy([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('loudly reports which files were skipped and how to apply them', () => {
    logSkippedPostDeploy([
      { file: '103_drop_org_credit_floor_default.sql', sql: '', scope: 'platform', phase: 'post-deploy' },
      { file: '104_null_out_org_credit_floor.sql', sql: '', scope: 'platform', phase: 'post-deploy' },
    ]);
    const output = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(output).toContain('103_drop_org_credit_floor_default.sql');
    expect(output).toContain('104_null_out_org_credit_floor.sql');
    expect(output).toContain(ALLOW_POST_DEPLOY_ENV_VAR);
    // Must tell the operator the actual command to run, not just the var name.
    expect(output).toMatch(/ALLOW_POST_DEPLOY_MIGRATIONS=1/);
  });
});

describe('098-104 credit_floor_usd phase headers (regression guard)', () => {
  // Pins the exact phase split this task exists to enforce: 098-102 are
  // pre-deploy (unmarked), 103-104 are post-deploy (marked). If a future edit
  // moves the `@phase: post-deploy` header to the wrong file, this fails
  // immediately instead of silently reopening the NaN-bypass window.
  const preDeploy = [
    '098_credit_floor_and_abandoned_leases.sql',
    '099_validate_credit_leases_status_check.sql',
    '100_seed_plan_credit_floors.sql',
    '101_null_out_org_credit_floor_default.sql',
    '102_repair_org_credit_floor_default.sql',
  ];
  const postDeploy = ['103_drop_org_credit_floor_default.sql', '104_null_out_org_credit_floor.sql'];

  it.each(preDeploy)('%s is pre-deploy (unmarked)', (file) => {
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    expect(parsePhaseHeader(sql)).toEqual('pre-deploy');
  });

  it.each(postDeploy)('%s is marked @phase: post-deploy', (file) => {
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    expect(parsePhaseHeader(sql)).toEqual('post-deploy');
  });

  it('a simulated 098→104 run stops after 102 without the opt-in flag', () => {
    const all = [...preDeploy, ...postDeploy].map((file) => ({
      file,
      sql: fs.readFileSync(path.join(__dirname, file), 'utf-8'),
    }));
    const { toApply, skipped } = planMigrations(all, false);
    expect(toApply.map((e) => e.file)).toEqual(preDeploy);
    expect(skipped.map((e) => e.file)).toEqual(postDeploy);
  });

  it('the same run completes all 7 files with the opt-in flag set', () => {
    const all = [...preDeploy, ...postDeploy].map((file) => ({
      file,
      sql: fs.readFileSync(path.join(__dirname, file), 'utf-8'),
    }));
    const { toApply, skipped } = planMigrations(all, true);
    expect(toApply.map((e) => e.file)).toEqual([...preDeploy, ...postDeploy]);
    expect(skipped).toEqual([]);
  });
});

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
        WHERE table_schema = 'public' AND table_name = 'app_meetings_webhooks'
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
