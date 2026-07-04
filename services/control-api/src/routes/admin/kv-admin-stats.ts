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
  // Each metric is collected independently: managed providers (e.g. Upstash) reject
  // CLIENT LIST and SLOWLOG, but still answer INFO. Don't let an unsupported command
  // mask the metrics that did succeed.
  const safe = <T>(p: Promise<T>, fallback: T): Promise<T> =>
    p.catch(() => fallback);
  try {
    const [memRaw, statsRaw, clientsListRaw, slowLenRaw] = await Promise.all([
      safe(r.info('memory'), ''),
      safe(r.info('stats'), ''),
      safe(r.call('CLIENT', 'LIST') as Promise<string>, ''),
      safe(r.call('SLOWLOG', 'LEN') as Promise<number>, 0),
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

  fastify.get<{ Querystring: { metric?: string; limit?: string } }>(
    '/admin/kv/top-apps',
    { config: { public: true } },
    async (req, reply) => {
      const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
      if (!user) return;

      const metric = req.query.metric === 'ops' || req.query.metric === 'errors' ? req.query.metric : 'storage';
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit ?? '20', 10) || 20));
      const ctrl = (fastify as any).controlDb;

      if (metric === 'storage') {
        const r = await ctrl.query(
          `SELECT s.app_id, u.id AS owner_id, u.email AS owner_email, s.region, s.bytes_used, s.keys_total, s.snapshot_at
             FROM kv_app_usage_snapshot s
             JOIN org_app_index oai ON oai.app_id = s.app_id
             JOIN organizations o ON o.id = oai.organization_id
             LEFT JOIN platform_users u ON u.id = o.owner_id
            ORDER BY s.bytes_used DESC
            LIMIT $1`, [limit]);
        return { metric, apps: r.rows };
      }

      if (metric === 'ops') {
        const r = await ctrl.query(
          `SELECT m.app_id, u.id AS owner_id, u.email AS owner_email, oai.region, SUM(m.quantity)::bigint AS value
             FROM usage_meters m
             JOIN org_app_index oai ON oai.app_id = m.app_id
             JOIN organizations o ON o.id = oai.organization_id
             LEFT JOIN platform_users u ON u.id = o.owner_id
            WHERE m.meter_type = 'kv_ops' AND m.period_start >= CURRENT_DATE
            GROUP BY m.app_id, u.id, u.email, oai.region
            ORDER BY value DESC
            LIMIT $1`, [limit]);
        return { metric, apps: r.rows };
      }

      // errors
      const r = await ctrl.query(
        `SELECT al.app_id, u.id AS owner_id, u.email AS owner_email, oai.region, COUNT(*)::bigint AS value
           FROM audit_logs al
           JOIN org_app_index oai ON oai.app_id = al.app_id
           JOIN organizations o ON o.id = oai.organization_id
           LEFT JOIN platform_users u ON u.id = o.owner_id
          WHERE al.path LIKE '/v1/%/kv/%'
            AND al.status_code >= 400
            AND al.at > now() - interval '24 hours'
          GROUP BY al.app_id, u.id, u.email, oai.region
          ORDER BY value DESC
          LIMIT $1`, [limit]);
      return { metric, apps: r.rows };
    },
  );

  fastify.get('/admin/kv/hotspots', { config: { public: true } }, async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;
    const ctrl = (fastify as any).controlDb;

    const storage = await ctrl.query(
      `SELECT s.app_id, s.region, s.bytes_used, p.kv_max_storage_bytes AS max_storage_bytes, s.snapshot_at
         FROM kv_app_usage_snapshot s
         JOIN org_app_index oai ON oai.app_id = s.app_id
         JOIN organizations o ON o.id = oai.organization_id
         LEFT JOIN plans p ON p.id = o.plan_id
        WHERE p.kv_max_storage_bytes IS NOT NULL
          AND s.bytes_used >= 0.9 * p.kv_max_storage_bytes`,
    );

    const rate = await ctrl.query(
      `SELECT al.app_id, akc.region,
              COUNT(*) FILTER (WHERE al.status_code = 429) AS rate_limited,
              COUNT(*) AS total_ops,
              MIN(al.at) FILTER (WHERE al.status_code = 429) AS first_seen
         FROM audit_logs al
         JOIN app_kv_credentials akc ON akc.app_id = al.app_id
        WHERE al.path LIKE '/v1/%/kv/%' AND al.at > now() - interval '24 hours'
        GROUP BY al.app_id, akc.region
       HAVING COUNT(*) FILTER (WHERE al.status_code = 429)::float / NULLIF(COUNT(*), 0) >= 0.05`,
    );

    const hotspots: any[] = [];
    for (const r of storage.rows) {
      const pct = Math.round((Number(r.bytes_used) / Number(r.max_storage_bytes)) * 100);
      hotspots.push({
        app_id: r.app_id, region: r.region,
        condition: `storage ${pct}% (${r.bytes_used} / ${r.max_storage_bytes} bytes)`,
        first_seen: r.snapshot_at,
      });
    }
    for (const r of rate.rows) {
      const pct = Math.round((Number(r.rate_limited) / Math.max(1, Number(r.total_ops))) * 100);
      hotspots.push({
        app_id: r.app_id, region: r.region,
        condition: `sustained 429s (${pct}% of ops, 24h)`,
        first_seen: r.first_seen,
      });
    }

    return { hotspots };
  });
};

function deriveStatus(i: { mem_used: number; mem_max: number; evicted_keys: number; slowlog_len: number }): 'green' | 'amber' | 'red' {
  if (i.evicted_keys > 0 || (i.mem_max > 0 && i.mem_used > 0.85 * i.mem_max) || i.slowlog_len > 100) return 'red';
  if (i.mem_max > 0 && i.mem_used > 0.7 * i.mem_max) return 'amber';
  return 'green';
}

export default kvAdminStatsRoutes;
