import { describe, it, expect, vi } from 'vitest';
import { executeCopyRuntime } from './step-copy-runtime.js';
import { MOVE_APP_RUNTIME_TABLES, MOVE_APP_RUNTIME_CHILD_TABLES } from './runtime-tables.js';

describe('executeCopyRuntime', () => {
  it('copies every runtime table and tags source rows', async () => {
    const source = { query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema')) return { rows: [{ column_name: 'id' }, { column_name: 'app_id' }] };
      if (sql.includes('SELECT')) return { rows: [{ id: 'x', app_id: 'a' }] };
      return { rows: [] };
    }) };
    const dest = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const ctx: any = {
      controlPool: { query: vi.fn() },
      runtimePoolFor: (r: string) => (r === 'us-east-1' ? source : dest),
      redisFor: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const m: any = { id: 'mig-1', app_id: 'a', source_region: 'us-east-1', dest_region: 'eu-west-1', current_step: 'copying_runtime', dest_resources: {} };
    const res = await executeCopyRuntime(ctx, m);
    expect(res.next).toBe('flipping_routing');
    expect(res.patch.copied_tables.length).toBeGreaterThanOrEqual(
      MOVE_APP_RUNTIME_TABLES.length + MOVE_APP_RUNTIME_CHILD_TABLES.length,
    );
    // All child tables must end up in copied_tables — guards against silent
    // regression of the agent-runs child-tables pass.
    for (const c of MOVE_APP_RUNTIME_CHILD_TABLES) {
      expect(res.patch.copied_tables).toContain(c.table);
    }
  });

  it('skips tables already in copied_tables', async () => {
    const source = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const dest = { query: vi.fn() };
    const ctx: any = {
      controlPool: { query: vi.fn() },
      runtimePoolFor: (r: string) => (r === 'us-east-1' ? source : dest),
      redisFor: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const m: any = {
      id: 'mig-1', app_id: 'a', source_region: 'us-east-1', dest_region: 'eu-west-1',
      current_step: 'copying_runtime',
      dest_resources: {
        copied_tables: [
          ...MOVE_APP_RUNTIME_TABLES,
          ...MOVE_APP_RUNTIME_CHILD_TABLES.map((c) => c.table),
        ],
      },
    };
    const res = await executeCopyRuntime(ctx, m);
    expect(source.query).not.toHaveBeenCalled();
    expect(res.next).toBe('flipping_routing');
  });

  it('uses the override PK column for non-id-PK tables (oauth_states)', async () => {
    const source = { query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema')) return { rows: [{ column_name: 'state' }, { column_name: 'app_id' }] };
      // First SELECT: return 1 row, second SELECT: empty (loop terminates)
      if (sql.includes('SELECT') && sql.includes('oauth_states')) {
        return { rows: [{ state: 's1', app_id: 'a' }] };
      }
      return { rows: [] };
    }) };
    const dest = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const ctx: any = {
      controlPool: { query: vi.fn() },
      runtimePoolFor: (r: string) => (r === 'us-east-1' ? source : dest),
      redisFor: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const m: any = {
      id: 'mig-1', app_id: 'a', source_region: 'us-east-1', dest_region: 'eu-west-1',
      current_step: 'copying_runtime',
      dest_resources: { copied_tables: [
        // Pre-mark every OTHER table as copied so the test only exercises oauth_states
        'app_users','app_refresh_tokens','app_verification_codes','app_signing_keys',
        'app_oauth_configs','app_connected_accounts','app_custom_domains','app_functions',
        'function_triggers','function_invocations','app_edge_ssr_deployments','app_durable_objects',
        'app_do_deploy_state','app_do_env_vars','app_frontend_env_vars','app_realtime_config',
        'app_integration_configs','storage_objects','app_orders','app_plans','app_products',
        'app_subscriptions','audit_events','ai_usage_logs','mcp_tool_call_log',
      ] },
    };
    await executeCopyRuntime(ctx, m);
    // Assert source.query was called with SQL containing ORDER BY "state"
    const allCalls = source.query.mock.calls.map((c: any) => c[0]);
    const stateOrderBy = allCalls.find((s: string) => s.includes('ORDER BY "state"'));
    expect(stateOrderBy).toBeDefined();
  });
});
