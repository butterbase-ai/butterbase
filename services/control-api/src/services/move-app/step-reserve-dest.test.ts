// services/control-api/src/services/move-app/step-reserve-dest.test.ts
import { describe, it, expect, vi } from 'vitest';
import { executeReserveDest } from './step-reserve-dest.js';

const SOURCE_ROW = {
  id: 'app-x', name: 'my-app', owner_id: 'owner-1', db_name: 'cust_app_x', subdomain: 'myapp',
  region: 'us-east-1', provisioning_status: 'ready', paused: true, paused_by: 'idle_reaper',
  paused_reason: 'Paused after 28 days without activity.', organization_id: 'org-1',
  deployment_backend: 'wfp', anon_key: 'anon-abc', access_mode: 'authenticated',
};

describe('executeReserveDest', () => {
  it('inserts dest apps row, provisions Neon db, returns next=blocking_writes', async () => {
    const sourceRuntime = { query: vi.fn().mockResolvedValue({ rows: [{ row: { id: 'app-x', name: 'my-app', db_name: 'cust_app_x', subdomain: null } }] }) };
    const destRuntime = { query: vi.fn().mockResolvedValue({ rows: [] }) };
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
    const destRuntime = { query: vi.fn().mockResolvedValue({ rows: [] }) };
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
    const [insertSql, insertParams] = destRuntime.query.mock.calls[0];
    expect(insertSql).toMatch(/json_populate_record\(NULL::apps, \$1::json\)/);
    const copied = JSON.parse(insertParams[0]);
    expect(copied).toEqual({
      ...SOURCE_ROW,
      db_name: 'cust_app_x__pending',
      region: 'eu-west-1',
      provisioning_status: 'migration_target_reserved',
    });
    expect(copied.owner_id).toBe('owner-1'); // not the mover
  });
});
