import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAppPlanFeatures } from './plan-features.js';
import * as regionResolver from './region-resolver.js';

vi.mock('./region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(),
}));

describe('getAppPlanFeatures', () => {
  let controlDb: any;
  let runtimeDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeDb = { query: vi.fn() };
    controlDb = { query: vi.fn() };
    (regionResolver.getRuntimeDbForApp as any).mockResolvedValue(runtimeDb);
  });

  it('reads features from the app organization_id\'s plan when set', async () => {
    runtimeDb.query.mockResolvedValueOnce({
      rows: [{ organization_id: 'org-team', owner_id: 'user-owner' }],
    });
    controlDb.query.mockResolvedValueOnce({ rows: [{ features: { custom_domain: true } }] });

    const features = await getAppPlanFeatures(controlDb, 'app-1', 'user-caller');

    expect(features).toEqual({ custom_domain: true });
    expect(regionResolver.getRuntimeDbForApp).toHaveBeenCalledWith(controlDb, 'app-1');
    expect(controlDb.query).toHaveBeenCalledTimes(1);
    expect(controlDb.query.mock.calls[0][0]).toMatch(/organizations o/);
    expect(controlDb.query.mock.calls[0][0]).toMatch(/JOIN plans p/);
    expect(controlDb.query.mock.calls[0][1]).toEqual(['org-team']);
  });

  it('falls back to the app owner\'s personal org when organization_id is NULL', async () => {
    runtimeDb.query.mockResolvedValueOnce({
      rows: [{ organization_id: null, owner_id: 'user-owner' }],
    });
    controlDb.query.mockResolvedValueOnce({ rows: [{ features: { staging: true } }] });

    const features = await getAppPlanFeatures(controlDb, 'app-2', 'user-caller');

    expect(features).toEqual({ staging: true });
    expect(controlDb.query.mock.calls[0][0]).toMatch(/platform_users pu/);
    expect(controlDb.query.mock.calls[0][1]).toEqual(['user-owner']);
  });

  it('falls back to fallbackUserId when the app row has no owner_id', async () => {
    runtimeDb.query.mockResolvedValueOnce({
      rows: [{ organization_id: null, owner_id: undefined }],
    });
    controlDb.query.mockResolvedValueOnce({ rows: [{ features: { staging: true } }] });

    await getAppPlanFeatures(controlDb, 'app-3', 'user-caller-fallback');

    expect(controlDb.query.mock.calls[0][1]).toEqual(['user-caller-fallback']);
  });

  it('returns {} when no plan row is found (fail open)', async () => {
    runtimeDb.query.mockResolvedValueOnce({
      rows: [{ organization_id: 'org-team', owner_id: 'user-owner' }],
    });
    controlDb.query.mockResolvedValueOnce({ rows: [] });

    const features = await getAppPlanFeatures(controlDb, 'app-4', 'user-caller');

    expect(features).toEqual({});
  });

  it('never consults the caller\'s personal org for a team-org app', async () => {
    runtimeDb.query.mockResolvedValueOnce({
      rows: [{ organization_id: 'org-team', owner_id: 'user-owner' }],
    });
    // If the helper accidentally queried the personal-org path (e.g. keyed off
    // fallbackUserId / the caller's own personal org) instead of the app's
    // owning org, it would get this different feature set back.
    controlDb.query.mockImplementation((sql: string) => {
      if (sql.includes('platform_users')) {
        return Promise.resolve({ rows: [{ features: { wrong_personal_org_feature: true } }] });
      }
      return Promise.resolve({ rows: [{ features: { custom_domain: true } }] });
    });

    const features = await getAppPlanFeatures(controlDb, 'app-5', 'caller-with-paid-personal-org');

    expect(features).toEqual({ custom_domain: true });
    expect(features).not.toHaveProperty('wrong_personal_org_feature');
    expect(controlDb.query).toHaveBeenCalledTimes(1);
    expect(controlDb.query.mock.calls[0][0]).not.toMatch(/platform_users/);
  });
});
