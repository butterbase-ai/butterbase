import { describe, it, expect, vi } from 'vitest';
import { writeActorUsageRow, type ActorUsageRow } from './usage-log.js';

describe('writeActorUsageRow', () => {
  const row: ActorUsageRow = {
    appId: 'app_1', userId: 'u_1',
    providerKey: 'meetings', actorId: 'bot_abc',
    dimension: 'recording', seconds: 90,
    usdCost: 0.0125, usdCharged: 0.01625, markupPct: 30,
    leaseId: 'lease_1', requestMetadata: { meeting_id: 'm_1' },
  };

  it('INSERTs ... ON CONFLICT DO NOTHING and returns true on first call', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 1 });
    const inserted = await writeActorUsageRow({ query } as any, row);
    expect(inserted).toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (actor_id, dimension) DO NOTHING'),
      expect.arrayContaining(['app_1','u_1','meetings','bot_abc','recording',90]),
    );
  });

  it('returns false on conflict (settle-once idempotency)', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 0 });
    const inserted = await writeActorUsageRow({ query } as any, row);
    expect(inserted).toBe(false);
  });
});
