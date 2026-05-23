import type { FastifyPluginAsync } from 'fastify';
import { Redis } from 'ioredis';
import { requireAdmin } from '../../lib/admin-guard.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Optional injection seam for tests; defaults to live INFO collection. */
    kvRedisInfo?(region: string): Promise<RegionInfo>;
  }
}

interface RegionInfo {
  mem_used: number;
  mem_max: number;
  hit_ratio: number;
  evicted_keys: number;
  clients: number;
  slowlog_len: number;
}

async function collectRegionInfo(region: string): Promise<RegionInfo> {
  const envKey = `KV_REDIS_URL_${region.toUpperCase().replace(/-/g, '_')}`;
  const url = process.env[envKey];
  if (!url) throw new Error(`Missing ${envKey}`);
  const r = new Redis(url, { maxRetriesPerRequest: 2 });
  try {
    const [memRaw, statsRaw, clientsListRaw, slowLenRaw] = await Promise.all([
      r.info('memory'),
      r.info('stats'),
      r.call('CLIENT', 'LIST') as Promise<string>,
      r.call('SLOWLOG', 'LEN') as Promise<number>,
    ]);
    const memUsed = parseInfoInt(memRaw, 'used_memory');
    const memMax  = parseInfoInt(memRaw, 'maxmemory') || 0;
    const hits    = parseInfoInt(statsRaw, 'keyspace_hits');
    const misses  = parseInfoInt(statsRaw, 'keyspace_misses');
    const evicted = parseInfoInt(statsRaw, 'evicted_keys');
    const hitRatio = hits + misses > 0 ? hits / (hits + misses) : 1;
    const clientCount = (clientsListRaw || '').split('\n').filter(Boolean).length;
    return {
      mem_used: memUsed,
      mem_max: memMax,
      hit_ratio: hitRatio,
      evicted_keys: evicted,
      clients: clientCount,
      slowlog_len: Number(slowLenRaw) || 0,
    };
  } finally {
    await r.quit().catch(() => {});
  }
}

function parseInfoInt(raw: string, field: string): number {
  const m = raw.match(new RegExp(`^${field}:(\\d+)`, 'm'));
  return m ? parseInt(m[1], 10) : 0;
}

const kvAdminStatsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/admin/kv/cluster-health', { config: { public: true } }, async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;

    const regionsRaw = process.env.BUTTERBASE_REGIONS ?? '';
    const regions = regionsRaw.split(',').map((r) => r.trim()).filter(Boolean);
    const infoFn = (fastify as any).kvRedisInfo ?? collectRegionInfo;

    const results = await Promise.all(regions.map(async (region) => {
      try {
        const info = await infoFn(region);
        return { region, ...info, status: deriveStatus(info), reachable: true };
      } catch (err) {
        return {
          region,
          mem_used: 0, mem_max: 0, hit_ratio: 0, evicted_keys: 0, clients: 0, slowlog_len: 0,
          status: 'red', reachable: false, error: (err as Error).message,
        };
      }
    }));

    return { regions: results };
  });
};

function deriveStatus(i: { mem_used: number; mem_max: number; evicted_keys: number; slowlog_len: number }): 'green' | 'amber' | 'red' {
  if (i.evicted_keys > 0 || (i.mem_max > 0 && i.mem_used > 0.85 * i.mem_max) || i.slowlog_len > 100) return 'red';
  if (i.mem_max > 0 && i.mem_used > 0.7 * i.mem_max) return 'amber';
  return 'green';
}

export default kvAdminStatsRoutes;
