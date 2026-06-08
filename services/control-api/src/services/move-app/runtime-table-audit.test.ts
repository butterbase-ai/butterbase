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
