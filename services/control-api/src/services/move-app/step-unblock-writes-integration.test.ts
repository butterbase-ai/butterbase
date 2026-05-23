// Integration test for unblock-writes KV sentinel clear against a real KV Redis.
// Split into its own file so that vi.mock calls in step-unblock-writes.test.ts
// do not shadow the real module imports needed here.
//
// Run with:
//   RUN_DB_TESTS=1 KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
//     pnpm --filter @butterbase/control-api test step-unblock-writes-integration

import { describe, it, expect } from 'vitest';
import { wrap } from '../kv/redis-client.js';
import { setKvBlock, isKvBlocked, clearKvBlock } from '../kv/migration-sentinel.js';
import { kvRedisFor } from '../kv/redis-registry.js';

describe.skipIf(!process.env.KV_REDIS_URL_US)(
  'executeUnblockWrites — real KV integration',
  () => {
    it('clears the KV sentinel so isKvBlocked returns false after unblock', async () => {
      const { randomUUID } = await import('node:crypto');
      const { Redis } = await import('ioredis');
      const { executeUnblockWrites } = await import('./step-unblock-writes.js');

      const url = process.env.KV_REDIS_URL_US!;
      const ioClient = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
      const client = wrap(ioClient);

      const appId = `unblock-sentinel-test-${randomUUID()}`;

      // Arrange: set the sentinel as block-writes would
      await setKvBlock(client, appId);
      expect(await isKvBlocked(client, appId)).toBe(true);

      // Stub ctx and m — the test only cares about the KV side
      const sourcePool = { query: async () => ({ rowCount: 1 }) };
      const ctx: any = {
        controlPool: { query: async () => ({}) },
        runtimePoolFor: () => sourcePool,
        redisFor: () => null,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      };
      const m: any = {
        id: 'mig-integration',
        app_id: appId,
        source_region: 'us',
        dest_region: 'eu',
        current_step: 'unblocking_writes',
        dest_resources: {},
      };

      // Act
      const res = await executeUnblockWrites(ctx, m);

      // Assert: saga advanced and sentinel is cleared
      expect(res.next).toBe('completed');
      expect(await isKvBlocked(wrap(kvRedisFor('us')), appId)).toBe(false);

      // Cleanup (defensive)
      await clearKvBlock(client, appId);
      await ioClient.quit();
    });
  },
);
