import { describe, it, expect, vi } from 'vitest';
import { auditRuntimeTablesForPool } from './runtime-table-audit.js';

/**
 * The audit issues two queries against the pool:
 *   1. `SELECT table_name … column_name = 'app_id'`            — app-id tables
 *   2. `… FROM pg_catalog.pg_constraint … contype = 'f'`       — FK relationships
 *
 * Make a pool stub that routes per-call by SQL substring, so tests can fail
 * at either layer independently.
 */
function makePool(opts: {
  appIdTables?: string[];
  fkPairs?: Array<{ child_table: string; parent_table: string }>;
}) {
  const appIdRows = (opts.appIdTables ?? []).map((t) => ({ table_name: t }));
  const fkRows = opts.fkPairs ?? [];
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("column_name = 'app_id'")) {
        return Promise.resolve({ rows: appIdRows });
      }
      if (sql.includes('pg_constraint')) {
        return Promise.resolve({ rows: fkRows });
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    }),
  };
}

describe('auditRuntimeTablesForPool — app_id tables', () => {
  it('passes when every app_id table is classified', async () => {
    const pool = makePool({ appIdTables: ['app_users', 'partner_keys'] });
    await expect(auditRuntimeTablesForPool(pool as any, 'us-east-1')).resolves.toBeUndefined();
  });

  it('throws when a per-app table is unclassified', async () => {
    const pool = makePool({ appIdTables: ['app_users', 'something_unknown'] });
    await expect(auditRuntimeTablesForPool(pool as any, 'us-east-1')).rejects.toThrow(/something_unknown/);
  });

  it('error message names the file to edit', async () => {
    const pool = makePool({ appIdTables: ['new_per_app_thing'] });
    await expect(auditRuntimeTablesForPool(pool as any, 'eu-west-1')).rejects.toThrow(/runtime-tables\.ts/);
  });

  it('also scans columns named <something>_app_id, not only bare app_id', async () => {
    // Regression: app_environments and staging_env_overrides key on
    // `prod_app_id` / `staging_app_id`. While the audit matched only the exact
    // name `app_id` it could not see either one, so the check that exists to
    // stop unclassified per-app tables reaching production was blind to the two
    // newest ones. The stub cannot run SQL, so assert the emitted query shape —
    // that IS the behaviour under test.
    const pool = makePool({ appIdTables: [] });
    await auditRuntimeTablesForPool(pool as any, 'us-east-1');
    const scanSql = pool.query.mock.calls.map((c: any[]) => String(c[0]))
      .find((sql: string) => sql.includes('information_schema.columns'));
    expect(scanSql).toContain('LIKE');
    expect(scanSql).toContain('_app');

  });

  it('classifies every %_app_id table that production actually has', async () => {
    // Widening the scan to `%_app_id` also pulled in apps.template_source_app_id.
    // `apps` had never needed classifying, so the wider audit would have
    // crash-looped control-api at boot on the first deploy. This list is the
    // real set, read off both production runtime DBs.
    const pool = makePool({
      appIdTables: ['apps', 'app_environments', 'staging_env_overrides'],
    });
    await expect(auditRuntimeTablesForPool(pool as any, 'us-east-1')).resolves.toBeUndefined();
  });

  it('keeps the staging link tables classified', async () => {
    // If either is dropped from MOVE_APP_EXCLUDED, the audit now fails at boot
    // rather than letting a region move silently orphan a staging environment.
    const pool = makePool({ appIdTables: ['app_environments', 'staging_env_overrides'] });
    await expect(auditRuntimeTablesForPool(pool as any, 'us-east-1')).resolves.toBeUndefined();
  });
});

describe('auditRuntimeTablesForPool — FK child tables', () => {
  it('passes when all FK children of registered parents are classified', async () => {
    // All 4 known agent_runs children are in MOVE_APP_RUNTIME_CHILD_TABLES.
    const pool = makePool({
      appIdTables: ['app_users'],
      fkPairs: [
        { child_table: 'agent_checkpoints',        parent_table: 'agent_runs' },
        { child_table: 'agent_run_events',         parent_table: 'agent_runs' },
        { child_table: 'agent_usage',              parent_table: 'agent_runs' },
        { child_table: 'agent_webhook_deliveries', parent_table: 'agent_runs' },
      ],
    });
    await expect(auditRuntimeTablesForPool(pool as any, 'us-east-1')).resolves.toBeUndefined();
  });

  it('throws when a new FK child of a registered parent is unclassified', async () => {
    const pool = makePool({
      appIdTables: ['app_users'],
      fkPairs: [
        { child_table: 'agent_run_new_thing', parent_table: 'agent_runs' },
      ],
    });
    await expect(auditRuntimeTablesForPool(pool as any, 'us-east-1')).rejects.toThrow(/agent_run_new_thing/);
  });

  it('error message names the child registry to edit', async () => {
    const pool = makePool({
      appIdTables: [],
      fkPairs: [
        { child_table: 'agent_run_new_thing', parent_table: 'agent_runs' },
      ],
    });
    await expect(auditRuntimeTablesForPool(pool as any, 'us-east-1')).rejects.toThrow(/MOVE_APP_RUNTIME_CHILD_TABLES/);
  });

  it('ignores FKs whose parent is not a registered move-app parent', async () => {
    // `partner_keys` is in MOVE_APP_EXCLUDED, not MOVE_APP_RUNTIME_TABLES, so
    // a child FK'd to it should not trigger the audit.
    const pool = makePool({
      appIdTables: ['app_users'],
      fkPairs: [
        { child_table: 'some_log_with_partner_id', parent_table: 'partner_keys' },
      ],
    });
    await expect(auditRuntimeTablesForPool(pool as any, 'us-east-1')).resolves.toBeUndefined();
  });

  it('ignores FK children that are themselves classified as parents', async () => {
    // `function_invocations` has app_id (so it's in MOVE_APP_RUNTIME_TABLES)
    // AND FKs to `app_functions`. The audit must not double-flag it.
    const pool = makePool({
      appIdTables: ['app_users', 'function_invocations'],
      fkPairs: [
        { child_table: 'function_invocations', parent_table: 'app_functions' },
      ],
    });
    await expect(auditRuntimeTablesForPool(pool as any, 'us-east-1')).resolves.toBeUndefined();
  });
});
