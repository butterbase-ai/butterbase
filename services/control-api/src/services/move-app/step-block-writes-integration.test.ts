// Integration test for block-writes sentinel logic against a real KV Redis.
// Split into its own file so that vi.mock calls in step-block-writes.test.ts
// do not shadow the real module imports needed here.
//
// Run with:
//   RUN_DB_TESTS=1 KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390 \
//     pnpm --filter @butterbase/control-api test step-block-writes-integration

import { describe, it, expect } from 'vitest';
import { RedisClient, wrap } from '../kv/redis-client.js';
import { setKvBlock, isKvBlocked, clearKvBlock } from '../kv/migration-sentinel.js';

describe.skipIf(!process.env.KV_REDIS_URL_US)(
  'executeBlockWrites — real KV integration',
  () => {
    it('isKvBlocked returns true after setKvBlock (verifies sentinel logic)', async () => {
      const { randomUUID } = await import('node:crypto');
      const { Redis } = await import('ioredis');
      const url = process.env.KV_REDIS_URL_US!;
      const ioClient = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });

      const appId = `block-test-${randomUUID()}`;
      const client = wrap(ioClient);

      await setKvBlock(client, appId);
      const blocked = await isKvBlocked(client, appId);
      expect(blocked).toBe(true);

      // Cleanup
      await clearKvBlock(client, appId);
      const unblocked = await isKvBlocked(client, appId);
      expect(unblocked).toBe(false);

      await ioClient.quit();
    });
  },
);
