import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import worker from '../src/worker.js';
import { RedisClient } from '../src/redis-client.js';

const env = {
  CONTROL_API_URL: 'http://ctl-mock',
  INTERNAL_SECRET: 'sek',
  REDIS_HOST_US: 'localhost',
  REDIS_HOST_EU: 'localhost',
  REDIS_PORT_US: '6390',   // kv-redis-1
  REDIS_PORT_EU: '6391',   // kv-redis-2
} as any;

const origFetch = globalThis.fetch;

function mockResolve(appId: string, region: 'us' | 'eu') {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ app_id: appId, region, redis_password: 'butterbase_dev_kv' }), { status: 200 }),
  ) as any;
}

function req(method: string, path: string, body?: unknown) {
  return new Request(`http://gw${path}`, {
    method,
    headers: { authorization: 'Bearer bb_live_x', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  // Pre-clean both Redises to make assertions deterministic.
  const us = await RedisClient.connect({ host: 'localhost', port: 6390, password: 'butterbase_dev_kv' });
  await us.del(['{app_isol}:u:probe']);
  await us.close();
  const eu = await RedisClient.connect({ host: 'localhost', port: 6391, password: 'butterbase_dev_kv' });
  await eu.del(['{app_isol}:u:probe']);
  await eu.close();
});

afterAll(() => { globalThis.fetch = origFetch; });

describe('region isolation', () => {
  it('an app pinned to us writes only to kv-redis-1, not kv-redis-2', async () => {
    mockResolve('app_isol', 'us');
    const put = await worker.fetch(req('PUT', '/v1/app_isol/kv/probe', { value: 'us-value' }), env);
    expect(put.status).toBe(204);

    const eu = await RedisClient.connect({ host: 'localhost', port: 6391, password: 'butterbase_dev_kv' });
    const v = await eu.get('{app_isol}:u:probe');
    await eu.close();
    expect(v).toBeNull();   // NOT in eu

    const us = await RedisClient.connect({ host: 'localhost', port: 6390, password: 'butterbase_dev_kv' });
    const v2 = await us.get('{app_isol}:u:probe');
    await us.close();
    expect(v2).toBe(JSON.stringify('us-value'));   // IS in us
  });
});
