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
    expect(r).toEqual({ ok: false, reason: 'App not found in org_app_index.' });
  });

  it('returns ok=false when source and dest regions are equal', async () => {
    const controlPool: any = fakePool([{ plan_id: 'launch', active_count: 0, region: 'us-east-1' }]);
    const r = await checkMoveAppEligibility(controlPool, 'app-1', 'us-east-1', { sourceRegion: 'us-east-1' });
    expect(r).toEqual({ ok: false, reason: 'Source and destination regions are equal.' });
  });
});

/**
 * `app_environments` FKs BOTH apps inside ONE regional runtime DB, so a staging
 * link cannot follow a single app across regions. Every alternative to refusing
 * loses something quietly: moving the row breaks its FK, and leaving it behind
 * orphans a staging app that still holds a full copy of production's data and
 * still bills, while vanishing from every status the owner can see.
 */
describe('checkMoveAppEligibility — staging links', () => {
  const eligibleRow = [{ plan_id: 'launch', active_count: 0, region: 'us-east-1' }];

  const runtimeWith = (rowsFor: { prod?: any[]; staging?: any[] }) => ({
    query: vi.fn().mockImplementation((sql: string) =>
      Promise.resolve({
        rows: sql.includes('prod_app_id = $1') ? (rowsFor.prod ?? []) : (rowsFor.staging ?? []),
      }),
    ),
  });

  it('refuses to move a production app that has a staging environment', async () => {
    const controlPool: any = fakePool(eligibleRow);
    const runtimeDb: any = runtimeWith({
      prod: [{ prod_app_id: 'app-1', staging_app_id: 'app-1-staging' }],
    });
    const r = await checkMoveAppEligibility(controlPool, 'app-1', 'eu-west-1', { runtimeDb });
    expect(r.ok).toBe(false);
    // Names the sibling, so the owner knows exactly what to unlink.
    expect((r as { reason: string }).reason).toContain('app-1-staging');
  });

  it('refuses to move a staging app away from its production app', async () => {
    const controlPool: any = fakePool(eligibleRow);
    const runtimeDb: any = runtimeWith({
      staging: [{ prod_app_id: 'app-prod', staging_app_id: 'app-1' }],
    });
    const r = await checkMoveAppEligibility(controlPool, 'app-1', 'eu-west-1', { runtimeDb });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('app-prod');
  });

  it('allows the move when the app is on neither end of a link', async () => {
    const controlPool: any = fakePool(eligibleRow);
    const runtimeDb: any = runtimeWith({});
    const r = await checkMoveAppEligibility(controlPool, 'app-1', 'eu-west-1', { runtimeDb });
    expect(r).toEqual({ ok: true });
  });

  it('never touches the runtime DB when a cheaper check already disqualifies', async () => {
    // The staging lookup is a second database round trip. It must sit behind
    // the checks that need no I/O at all, or every ineligible move pays for it.
    const controlPool: any = fakePool([{ plan_id: null, active_count: 0, region: 'us-east-1' }]);
    const runtimeDb: any = runtimeWith({});
    const r = await checkMoveAppEligibility(controlPool, 'app-1', 'eu-west-1', { runtimeDb });
    expect(r).toEqual({ ok: false, reason: 'Owner has no active plan.' });
    expect(runtimeDb.query).not.toHaveBeenCalled();
  });
});
