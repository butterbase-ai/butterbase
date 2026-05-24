import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import kvAdminStatsRoutes from './kv-admin-stats.js';

describe('GET /admin/kv/cluster-health', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns per-region INFO snapshots', async () => {
    process.env.BUTTERBASE_REGIONS = 'region-1,region-2';
    process.env.KV_REDIS_URL_REGION_1 = 'redis://x:y@host-1:6379';
    process.env.KV_REDIS_URL_REGION_2 = 'redis://x:y@host-2:6379';

    const app = Fastify({ logger: false });
    const ctrl = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'u', email: 'a', display_name: null, is_admin: true }] }) };
    const authProvider = { async verifyJwt() { return { sub: 'sub-1' }; } };
    const fakeInfo = (region: string) => ({
      mem_used:   region === 'region-1' ? 412_000_000 : 198_000_000,
      mem_max:    4_096_000_000,
      hit_ratio:  region === 'region-1' ? 0.984 : 0.971,
      evicted_keys: 0,
      clients:    region === 'region-1' ? 124 : 47,
      slowlog_len: 0,
    });

    const fp = (await import('fastify-plugin')).default;
    await app.register(fp(async (i: any) => {
      i.decorate('controlDb', ctrl);
      i.decorate('authProvider', authProvider);
      i.decorate('kvRedisInfo', async (region: string) => fakeInfo(region));
    }, { name: 'shim' }));
    await app.register(kvAdminStatsRoutes);

    const r = await app.inject({
      method: 'GET',
      url: '/admin/kv/cluster-health',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.regions).toHaveLength(2);
    expect(body.regions[0].region).toBe('region-1');
    expect(body.regions[0].mem_used).toBe(412_000_000);
  });

  it('returns 403 for non-admin users', async () => {
    const app = Fastify({ logger: false });
    const ctrl = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'u', email: 'a', display_name: null, is_admin: false }] }) };
    const authProvider = { async verifyJwt() { return { sub: 'sub-1' }; } };
    const fp = (await import('fastify-plugin')).default;
    await app.register(fp(async (i: any) => {
      i.decorate('controlDb', ctrl);
      i.decorate('authProvider', authProvider);
      i.decorate('kvRedisInfo', async () => ({ mem_used: 0, mem_max: 0, hit_ratio: 0, evicted_keys: 0, clients: 0, slowlog_len: 0 }));
    }, { name: 'shim' }));
    await app.register(kvAdminStatsRoutes);
    const r = await app.inject({ method: 'GET', url: '/admin/kv/cluster-health', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(403);
  });
});

describe('GET /admin/kv/top-apps', () => {
  it('returns the top N by bytes_used desc', async () => {
    const rows = [
      { app_id: 'a1', owner_id: 'u1', owner_email: 'a@a', region: 'region-1', bytes_used: 5_000_000_000, keys_total: 10_000 },
      { app_id: 'a2', owner_id: 'u2', owner_email: 'b@b', region: 'region-2', bytes_used: 4_000_000_000, keys_total: 8_000 },
      { app_id: 'a3', owner_id: 'u3', owner_email: 'c@c', region: 'region-1', bytes_used: 1_000_000,     keys_total: 500   },
    ];
    const app = Fastify({ logger: false });
    const ctrl = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FROM platform_users')) return { rows: [{ id: 'u', email: 'admin', display_name: null, is_admin: true }] };
        if (sql.includes('FROM kv_app_usage_snapshot')) return { rows };
        return { rows: [] };
      }),
    };
    const fp = (await import('fastify-plugin')).default;
    await app.register(fp(async (i: any) => {
      i.decorate('controlDb', ctrl);
      i.decorate('authProvider', { async verifyJwt() { return { sub: 's' }; } });
    }, { name: 'shim' }));
    await app.register(kvAdminStatsRoutes);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/kv/top-apps?metric=storage&limit=10',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.apps).toHaveLength(3);
    expect(body.apps[0].app_id).toBe('a1');
  });
});

describe('GET /admin/kv/hotspots', () => {
  it('returns apps near caps and apps with high 429 rates', async () => {
    const app = Fastify({ logger: false });
    const ctrl = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FROM platform_users')) return { rows: [{ id: 'u', email: 'admin', display_name: null, is_admin: true }] };
        if (sql.includes('FROM kv_app_usage_snapshot s')) {
          return { rows: [{ app_id: 'cap1', region: 'region-1', bytes_used: 6_400_000_000, max_storage_bytes: 6_710_886_400, snapshot_at: new Date() }] };
        }
        if (sql.includes('FROM audit_logs')) {
          return { rows: [{ app_id: 'spam1', region: 'region-2', total_ops: 1000, rate_limited: 80, first_seen: new Date() }] };
        }
        return { rows: [] };
      }),
    };
    const fp = (await import('fastify-plugin')).default;
    await app.register(fp(async (i: any) => {
      i.decorate('controlDb', ctrl);
      i.decorate('authProvider', { async verifyJwt() { return { sub: 's' }; } });
    }, { name: 'shim' }));
    await app.register(kvAdminStatsRoutes);
    const r = await app.inject({ method: 'GET', url: '/admin/kv/hotspots', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.hotspots.length).toBeGreaterThanOrEqual(2);
    expect(body.hotspots.some((h: any) => h.app_id === 'cap1')).toBe(true);
    expect(body.hotspots.some((h: any) => h.app_id === 'spam1')).toBe(true);
  });
});
