// Integration test for abort KV sentinel clear against a real KV Redis.
// Split into its own file so that vi.mock calls in step-abort.test.ts
// do not shadow the real module imports needed here.
//
// Run with:
//   RUN_DB_TESTS=1 KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
//                  KV_REDIS_URL_EU=redis://:butterbase_dev_kv@localhost:6391 \
//     pnpm --filter @butterbase/control-api test step-abort-integration

import { describe, it, expect } from 'vitest';
import { wrap } from '../kv/redis-client.js';
import { setKvBlock, isKvBlocked, clearKvBlock } from '../kv/migration-sentinel.js';
import { kvRedisFor } from '../kv/redis-registry.js';

describe.skipIf(!process.env.KV_REDIS_URL_US)(
  'executeAbort — real KV integration',
  () => {
    it('clears the source KV sentinel on abort so isKvBlocked returns false', async () => {
      const { randomUUID } = await import('node:crypto');
      const { Redis } = await import('ioredis');
      const { executeAbort } = await import('./step-abort.js');

      const url = process.env.KV_REDIS_URL_US!;
      const ioClient = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
      const client = wrap(ioClient);

      const appId = `abort-sentinel-test-${randomUUID()}`;

      // Arrange: set the source sentinel as block-writes would
      await setKvBlock(client, appId);
      expect(await isKvBlocked(client, appId)).toBe(true);

      // Stub ctx — test only cares about KV; dest_resources={} so dest cleanup no-ops
      const ctx: any = {
        controlPool: { query: async () => ({}) },
        runtimePoolFor: () => ({ query: async () => ({ rowCount: 0 }) }),
        redisFor: () => null,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      };
      const m: any = {
        id: 'mig-integration-abort',
        app_id: appId,
        source_region: 'us',
        dest_region: 'eu',
        current_step: 'aborting',
        dest_resources: {},
      };

      // Act
      const res = await executeAbort(ctx, m);

      // Assert: saga aborted and source sentinel is cleared
      expect(res.next).toBe('aborted');
      expect(await isKvBlocked(wrap(kvRedisFor('us')), appId)).toBe(false);

      // Cleanup (defensive)
      await clearKvBlock(client, appId);
      await ioClient.quit();
    });
  },
);
