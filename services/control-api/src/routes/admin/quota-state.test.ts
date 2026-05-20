import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import internalAuthPlugin from '../../plugins/internal-auth.js';
import quotaStateRoutes from './quota-state.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let app: ReturnType<typeof Fastify>;
let pool: pg.Pool;

beforeAll(async () => {
  process.env.BUTTERBASE_INTERNAL_SECRET = 'test-secret';
  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  app = Fastify();
  app.decorate('controlDb', pool);
  await app.register(internalAuthPlugin);
  await app.register(quotaStateRoutes);
  await app.ready();
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('GET /v1/internal/quota-state', () => {
  it('returns combined health snapshot', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/internal/quota-state',
      headers: { 'x-butterbase-internal-secret': 'test-secret' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      outbox: { pending: expect.any(Number), oldestPendingSeconds: expect.any(Number) },
      leases: { activeCount: expect.any(Number), totalActiveUsd: expect.any(Number) },
      reclaim: { reclaimedLast24h: expect.any(Number), reclaimedTotalUsd24h: expect.any(Number) },
    });
  });
});
