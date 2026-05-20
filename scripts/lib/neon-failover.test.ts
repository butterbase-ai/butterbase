import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promoteReplicaToPrimary, getReplicationLagSeconds } from './neon-failover.js';

const ORIG_FETCH = global.fetch;

describe('neon-failover', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = ORIG_FETCH;
  });

  it('promoteReplicaToPrimary calls Neon API with expected URL and method', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ project: { id: 'standby-id' } }),
    });

    await promoteReplicaToPrimary({
      apiKey: 'test-key',
      projectId: 'standby-id',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://console.neon.tech/api/v2/projects/standby-id/promote',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      })
    );
  });

  it('promoteReplicaToPrimary throws on non-2xx', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: 'forbidden' }),
      text: async () => 'forbidden',
    });

    await expect(
      promoteReplicaToPrimary({ apiKey: 'k', projectId: 'p' })
    ).rejects.toThrow(/Neon promotion failed/);
  });

  it('getReplicationLagSeconds parses pg_last_wal_replay_lag', async () => {
    const fakeClient = {
      connect: vi.fn(),
      query: vi.fn().mockResolvedValue({
        rows: [{ lag_seconds: 0.42 }],
      }),
      end: vi.fn(),
    };
    const lag = await getReplicationLagSeconds('postgres://standby', fakeClient as any);
    expect(lag).toBe(0.42);
  });

  it('getReplicationLagSeconds returns null when lag_seconds is null', async () => {
    const fakeClient = {
      connect: vi.fn(),
      query: vi.fn().mockResolvedValue({
        rows: [{ lag_seconds: null }],
      }),
      end: vi.fn(),
    };
    const lag = await getReplicationLagSeconds('postgres://standby', fakeClient as any);
    expect(lag).toBeNull();
  });
});
