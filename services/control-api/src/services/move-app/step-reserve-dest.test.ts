// services/control-api/src/services/move-app/step-reserve-dest.test.ts
import { describe, it, expect, vi } from 'vitest';
import { executeReserveDest } from './step-reserve-dest.js';

describe('executeReserveDest', () => {
  it('inserts dest apps row, provisions Neon db, returns next=blocking_writes', async () => {
    const sourceRuntime = { query: vi.fn().mockResolvedValue({ rows: [{ name: 'my-app', db_name: 'cust_app_x', subdomain: null }] }) };
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
});
