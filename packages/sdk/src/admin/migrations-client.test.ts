import { describe, it, expect } from 'vitest';
import { AdminMigrationsClient } from './migrations-client';

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

describe('AdminMigrationsClient', () => {
  it('listRegions hits GET /v1/regions', async () => {
    const { fc, calls } = fakeClient();
    await new AdminMigrationsClient(fc).listRegions();
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/v1/regions' });
  });

  it('move posts dest_region', async () => {
    const { fc, calls } = fakeClient();
    await new AdminMigrationsClient(fc).move('app_x', 'us-west-2');
    expect(calls[0]).toMatchObject({
      method: 'POST', path: '/v1/apps/app_x/move',
      body: { dest_region: 'us-west-2' },
    });
  });

  it('getStatus, getActive, abort, reverse hit the right routes', async () => {
    const { fc, calls } = fakeClient();
    const c = new AdminMigrationsClient(fc);
    await c.getStatus('app_x', 'm1');
    await c.getActive('app_x');
    await c.abort('app_x', 'm1');
    await c.reverse('app_x', 'm1');
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/apps/app_x/migrations/m1',
      'GET /v1/apps/app_x/migrations/active',
      'POST /v1/apps/app_x/migrations/m1/abort',
      'POST /v1/apps/app_x/migrations/m1/reverse',
    ]);
  });

  it('listSourceReplicas + tearDownSourceReplica', async () => {
    const { fc, calls } = fakeClient();
    const c = new AdminMigrationsClient(fc);
    await c.listSourceReplicas();
    await c.tearDownSourceReplica('m1');
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/source-replicas',
      'DELETE /v1/source-replicas/m1',
    ]);
  });

  it('returns {data:null, error} when request throws', async () => {
    const fc: any = { request: () => Promise.reject(new Error('boom')) };
    const r = await new AdminMigrationsClient(fc).listRegions();
    expect(r.data).toBeNull();
    expect(r.error?.message).toBe('boom');
  });
});
