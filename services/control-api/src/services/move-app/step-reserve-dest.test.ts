// services/control-api/src/services/move-app/step-reserve-dest.test.ts
import { describe, it, expect, vi } from 'vitest';
import { executeReserveDest } from './step-reserve-dest.js';

const SOURCE_ROW = {
  id: 'app-x', name: 'my-app', owner_id: 'owner-1', db_name: 'cust_app_x', subdomain: 'myapp',
  region: 'us-east-1', provisioning_status: 'ready', paused: true, paused_by: 'idle_reaper',
  paused_reason: 'Paused after 28 days without activity.', organization_id: 'org-1',
  deployment_backend: 'wfp', anon_key: 'anon-abc', access_mode: 'authenticated',
  db_provisioned: true, provisioning_error: 'old',
};

// First dest query is the information_schema column list; the rest return no rows.
const destPoolFor = (columns: string[]) => ({
  query: vi.fn().mockImplementation((sql: string) =>
    Promise.resolve({ rows: sql.includes('information_schema.columns') ? columns.map((column_name) => ({ column_name })) : [] }),
  ),
});

describe('executeReserveDest', () => {
  it('inserts dest apps row, provisions Neon db, returns next=blocking_writes', async () => {
    const sourceRuntime = { query: vi.fn().mockResolvedValue({ rows: [{ row: { id: 'app-x', name: 'my-app', db_name: 'cust_app_x', subdomain: null } }] }) };
    const destRuntime = destPoolFor(['id', 'name', 'db_name', 'subdomain', 'region', 'provisioning_status', 'db_provisioned', 'provisioning_error']);
    const ctx: any = {
      controlPool: { query: vi.fn() },
      runtimePoolFor: (r: string) => (r === 'eu-west-1' ? destRuntime : sourceRuntime),
      redisFor: () => null,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provisionAppDb: vi.fn().mockResolvedValue({ neonDbName: 'cust_app_x_dest', connectionUri: 'postgresql://...' }),
    };
    const m: any = {
      id: 'mig-1', app_id: 'app-x', user_id: 'u', source_region: 'us-east-1',
      dest_region: 'eu-west-1', current_step: 'reserving_dest', dest_resources: {},
    };
    const res = await executeReserveDest(ctx, m);
    expect(res.next).toBe('blocking_writes');
    expect(res.patch).toMatchObject({ neon_db_name: 'cust_app_x_dest' });
    expect(ctx.provisionAppDb).toHaveBeenCalledOnce();
  });

  it('is idempotent — second call skips both inserts', async () => {
    const ctx: any = {
      controlPool: { query: vi.fn() },
      runtimePoolFor: () => ({ query: vi.fn() }),
      redisFor: () => null,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provisionAppDb: vi.fn(),
    };
    const m: any = {
      id: 'mig-2', app_id: 'app-x', user_id: 'u', source_region: 'us-east-1',
      dest_region: 'eu-west-1', current_step: 'reserving_dest',
      dest_resources: { neon_db_name: 'already', dest_app_id: 'app-x' },
    };
    const res = await executeReserveDest(ctx, m);
    expect(res.next).toBe('blocking_writes');
    expect(ctx.provisionAppDb).not.toHaveBeenCalled();
  });

  it('rejects a same-region move before touching either region', async () => {
    const runtime = { query: vi.fn() };
    const ctx: any = {
      controlPool: { query: vi.fn() },
      runtimePoolFor: () => runtime,
      redisFor: () => null,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provisionAppDb: vi.fn(),
    };
    const m: any = {
      id: 'mig-3', app_id: 'app-x', user_id: 'u', source_region: 'us-east-1',
      dest_region: 'us-east-1', current_step: 'reserving_dest', dest_resources: {},
    };

    await expect(executeReserveDest(ctx, m)).rejects.toThrow(/us-east-1/);
    expect(ctx.provisionAppDb).not.toHaveBeenCalled();
    expect(runtime.query).not.toHaveBeenCalled();
  });

  it('Review Focus #4: copies the full source row with only the move overrides', async () => {
    const sourceRuntime = { query: vi.fn().mockResolvedValue({ rows: [{ row: { ...SOURCE_ROW } }] }) };
    const destRuntime = destPoolFor([...Object.keys(SOURCE_ROW)]);
    const ctx: any = {
      controlPool: { query: vi.fn() },
      runtimePoolFor: (r: string) => (r === 'eu-west-1' ? destRuntime : sourceRuntime),
      redisFor: () => null,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      provisionAppDb: vi.fn().mockResolvedValue({ neonDbName: 'd', connectionUri: 'postgresql://...' }),
    };
    const m: any = {
      id: 'mig-4', app_id: 'app-x', user_id: 'mover-2', source_region: 'us-east-1',
      dest_region: 'eu-west-1', current_step: 'reserving_dest', dest_resources: {},
    };
    await executeReserveDest(ctx, m);

    expect(sourceRuntime.query.mock.calls[0][0]).toMatch(/row_to_json/);
    expect(destRuntime.query.mock.calls[0][0]).toMatch(/information_schema\.columns/);
    const [insertSql, insertParams] = destRuntime.query.mock.calls[1];
    expect(insertSql).toMatch(/json_populate_record\(NULL::apps, \$1::json\)/);
    const copied = JSON.parse(insertParams[0]);
    expect(copied).toEqual({
      ...SOURCE_ROW,
      db_name: 'cust_app_x__pending',
      region: 'eu-west-1',
      provisioning_status: 'migration_target_reserved',
      db_provisioned: false,
      provisioning_error: null,
    });
    expect(copied.owner_id).toBe('owner-1'); // not the mover

    // Conflict branch refreshes every copied column, never the key.
    expect(insertSql).toContain('"paused" = EXCLUDED."paused"');
    expect(insertSql).toContain('"paused_by" = EXCLUDED."paused_by"');
    expect(insertSql).toContain('"organization_id" = EXCLUDED."organization_id"');
    expect(insertSql).not.toContain('"id" =');
  });

  it('only sets columns that exist on the destination and rejects unsafe names', async () => {
    const mk = (cols: string[], srcRow: Record<string, unknown>) => {
      const sourceRuntime = { query: vi.fn().mockResolvedValue({ rows: [{ row: srcRow }] }) };
      const destRuntime = destPoolFor(cols);
      const ctx: any = {
        controlPool: { query: vi.fn() },
        runtimePoolFor: (r: string) => (r === 'eu-west-1' ? destRuntime : sourceRuntime),
        redisFor: () => null,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        provisionAppDb: vi.fn().mockResolvedValue({ neonDbName: 'd', connectionUri: 'x' }),
      };
      const m: any = {
        id: 'mig-5', app_id: 'app-x', user_id: 'u', source_region: 'us-east-1',
        dest_region: 'eu-west-1', current_step: 'reserving_dest', dest_resources: {},
      };
      return { ctx, m, destRuntime };
    };
    const a = mk(['id', 'paused', 'db_name', 'region', 'provisioning_status', 'db_provisioned', 'provisioning_error'],
      { id: 'app-x', db_name: 'd', paused: true, extra_src_only: 1 });
    await executeReserveDest(a.ctx, a.m);
    expect(a.destRuntime.query.mock.calls[1][0]).not.toContain('extra_src_only');

    const b = mk(['id', 'db_name', 'Bad-Col'], { id: 'app-x', db_name: 'd', 'Bad-Col': 1 });
    await expect(executeReserveDest(b.ctx, b.m)).rejects.toThrow(/unsafe/);
  });
});
