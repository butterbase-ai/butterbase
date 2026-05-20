import pg from 'pg';

export interface RuntimeDbConfig {
  urlsByRegion: Record<string, string>;
}

export function resolveRuntimeDbUrl(cfg: RuntimeDbConfig, region: string): string {
  const url = cfg.urlsByRegion[region];
  if (url === undefined) {
    throw new Error(`No runtime DB URL configured for region "${region}"`);
  }
  if (!url) {
    throw new Error(`Runtime DB URL for region "${region}" is empty`);
  }
  return url;
}

const pools = new Map<string, pg.Pool>();

/**
 * Returns the runtime DB pg.Pool for a given region. Pools are cached per region
 * and created lazily on first access. The same pool is returned for repeated
 * calls with the same region.
 *
 * Caller-side lifecycle: pools persist for the process lifetime. Callers should
 * not call .end() on a returned pool.
 */
export function getRuntimeDbPool(cfg: RuntimeDbConfig, region: string): pg.Pool {
  const cached = pools.get(region);
  if (cached) return cached;
  const url = resolveRuntimeDbUrl(cfg, region);
  const pool = new pg.Pool({ connectionString: url });
  pools.set(region, pool);
  return pool;
}

/** For testing: clears the per-region pool cache. */
export function _resetRuntimeDbPools(): void {
  pools.clear();
}
