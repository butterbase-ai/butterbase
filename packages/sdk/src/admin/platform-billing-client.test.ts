import { describe, it, expect } from 'vitest';
import { AdminPlatformBillingClient } from './platform-billing-client';

function fakeClient() {
  const calls: any[] = [];
  const fc: any = {
    request: (method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      return Promise.resolve({});
    },
  };
  return { fc, calls };
}

describe('AdminPlatformBillingClient', () => {
  it('hits the right dashboard routes', async () => {
    const { fc, calls } = fakeClient();
    const c = new AdminPlatformBillingClient(fc);
    await c.getStatus();
    await c.openPortal();
    await c.topup({ amount_usd: 25 });
    await c.getSpendingCap();
    await c.setSpendingCap({ limit: 200, period: 'monthly' });
    await c.listPlans();
    await c.getUsage({ meterType: 'ai_tokens' });
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /dashboard/billing',
      'POST /dashboard/billing/portal',
      'POST /dashboard/billing/topup',
      'GET /dashboard/billing/spending-cap',
      'PUT /dashboard/billing/spending-cap',
      'GET /dashboard/plans',
      'GET /dashboard/usage?meterType=ai_tokens',
    ]);
  });

  it('topup body is forwarded as-is', async () => {
    const { fc, calls } = fakeClient();
    await new AdminPlatformBillingClient(fc).topup({ amount_usd: 50, currency: 'usd' });
    expect(calls[0].body).toEqual({ amount_usd: 50, currency: 'usd' });
  });

  it('getUsage forwards all 3 filters', async () => {
    const { fc, calls } = fakeClient();
    await new AdminPlatformBillingClient(fc).getUsage({
      startDate: '2026-01-01', endDate: '2026-02-01', meterType: 'storage_bytes',
    });
    const url = new URL('http://x' + calls[0].path);
    expect(url.searchParams.get('startDate')).toBe('2026-01-01');
    expect(url.searchParams.get('endDate')).toBe('2026-02-01');
    expect(url.searchParams.get('meterType')).toBe('storage_bytes');
  });

  it('getUsage with no opts hits bare path', async () => {
    const { fc, calls } = fakeClient();
    await new AdminPlatformBillingClient(fc).getUsage();
    expect(calls[0].path).toBe('/dashboard/usage');
  });

  it('error case returns {data:null, error}', async () => {
    const fc: any = { request: () => Promise.reject(new Error('boom')) };
    const r = await new AdminPlatformBillingClient(fc).getStatus();
    expect(r.data).toBeNull();
    expect(r.error?.message).toBe('boom');
  });
});
