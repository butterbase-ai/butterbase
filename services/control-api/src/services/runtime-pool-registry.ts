import pg from 'pg';

const pools = new Map<string, pg.Pool>();

function envKeyForRegion(region: string): string {
  return `NEON_RUNTIME_PROJECT_ID_${region.toUpperCase().replace(/-/g, '_')}`;
}

export function runtimePoolFor(region: string): pg.Pool {
  let pool = pools.get(region);
  if (pool) return pool;
  const url = process.env[envKeyForRegion(region)];
  if (!url) throw new Error(`Missing ${envKeyForRegion(region)} for region ${region}`);
  pool = new pg.Pool({ connectionString: url, max: 5 });
  pools.set(region, pool);
  return pool;
}

export async function shutdownAllRuntimePools(): Promise<void> {
  await Promise.all(Array.from(pools.values()).map((p) => p.end().catch(() => {})));
  pools.clear();
}

export function listRuntimeRegions(): string[] {
  return (process.env.BUTTERBASE_REGIONS ?? 'local').split(',').map(s => s.trim()).filter(Boolean);
}
