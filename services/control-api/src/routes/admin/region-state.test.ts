import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import internalAuthPlugin from '../../plugins/internal-auth.js';
import regionStateRoutes from './region-state.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let app: ReturnType<typeof Fastify>;
let pool: pg.Pool;

beforeAll(async () => {
  process.env.BUTTERBASE_INTERNAL_SECRET = 'test-secret';
  process.env.BUTTERBASE_REGIONS = 'us-east-1';
  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  app = Fastify();
  app.decorate('controlDb', pool);
  await app.register(internalAuthPlugin);
  await app.register(regionStateRoutes);
  await app.ready();
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('GET /v1/internal/region-state', () => {
  it('returns per-region counts and config', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/internal/region-state',
      headers: { 'x-butterbase-internal-secret': 'test-secret' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.configuredRegions).toEqual(['us-east-1']);
    expect(body.appCountByRegion).toMatchObject({ 'us-east-1': expect.any(Number) });
  });
});
