import { describe, it, expect, afterEach } from 'vitest';
import { kvRedisFor, shutdownAllKvRedisClients } from './redis-registry';

const skipIfNoEnv = !process.env.KV_REDIS_URL_US ? describe.skip : describe;

skipIfNoEnv('KV Redis Registry', () => {
  afterEach(async () => {
    await shutdownAllKvRedisClients();
  });

  it('returns same client for same region', () => {
    const client1 = kvRedisFor('us');
    const client2 = kvRedisFor('us');
    expect(client1).toBe(client2);
  });

  it('returns different clients for different regions', async (context) => {
    if (!process.env.KV_REDIS_URL_EU) {
      context.skip();
    }
    const clientUs = kvRedisFor('us');
    const clientEu = kvRedisFor('eu');
    expect(clientUs).not.toBe(clientEu);
  });

  it('PING returns PONG', async () => {
    const client = kvRedisFor('us');
    const result = await client.ping();
    expect(result).toBe('PONG');
  });
});
