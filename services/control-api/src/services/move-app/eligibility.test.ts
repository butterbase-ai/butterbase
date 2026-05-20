import { describe, it, expect, vi } from 'vitest';
import { checkMoveAppEligibility } from './eligibility.js';

const fakePool = (rows: any[]) => ({
  query: vi.fn().mockResolvedValue({ rows }),
});

describe('checkMoveAppEligibility', () => {
  it('returns ok=true when app exists, owner has a plan, and no active migration', async () => {
    const controlPool: any = fakePool([{ plan_id: 'launch', active_count: 0, region: 'us-east-1' }]);
    const r = await checkMoveAppEligibility(controlPool, 'app-1', 'eu-west-1');
    expect(r).toEqual({ ok: true });
  });

  it('returns ok=false when an active migration already exists', async () => {
    const controlPool: any = fakePool([{ plan_id: 'launch', active_count: 1, region: 'us-east-1' }]);
    const r = await checkMoveAppEligibility(controlPool, 'app-1', 'eu-west-1');
    expect(r).toEqual({ ok: false, reason: 'A migration is already in flight for this app.' });
  });

  it('returns ok=false when owner has no plan_id', async () => {
    const controlPool: any = fakePool([{ plan_id: null, active_count: 0, region: 'us-east-1' }]);
    const r = await checkMoveAppEligibility(controlPool, 'app-1', 'eu-west-1');
    expect(r).toEqual({ ok: false, reason: 'Owner has no active plan.' });
  });

  it('returns ok=false when app is not indexed (404)', async () => {
    const controlPool: any = fakePool([]);
    const r = await checkMoveAppEligibility(controlPool, 'missing', 'eu-west-1');
    expect(r).toEqual({ ok: false, reason: 'App not found in user_app_index.' });
  });

  it('returns ok=false when source and dest regions are equal', async () => {
    const controlPool: any = fakePool([{ plan_id: 'launch', active_count: 0, region: 'us-east-1' }]);
    const r = await checkMoveAppEligibility(controlPool, 'app-1', 'us-east-1', { sourceRegion: 'us-east-1' });
    expect(r).toEqual({ ok: false, reason: 'Source and destination regions are equal.' });
  });
});
