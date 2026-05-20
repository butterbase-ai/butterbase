import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import internalAuthPlugin from '../../plugins/internal-auth.js';
import activeMigrationsRoutes from './active-migrations.js';

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
  await app.register(activeMigrationsRoutes);
  await app.ready();
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('GET /v1/internal/active-migrations', () => {
  it('returns active migration stats', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/internal/active-migrations',
      headers: { 'x-butterbase-internal-secret': 'test-secret' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toHaveProperty('by_step');
    expect(body).toHaveProperty('by_region_pair');
    expect(body).toHaveProperty('active_source_replicas');
    expect(Array.isArray(body.by_step)).toBe(true);
    expect(Array.isArray(body.by_region_pair)).toBe(true);
    expect(typeof body.active_source_replicas).toBe('number');
  });
});
