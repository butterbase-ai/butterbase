import { config } from '../config.js';

const dataCache = new Map<string, string>();
const runtimeCache = new Map<string, string>();

function envKey(prefix: string, region: string): string {
  return `${prefix}_${region.toUpperCase().replace(/-/g, '_')}`;
}

export function getDataProjectIdForRegion(region: string): string {
  const cached = dataCache.get(region);
  if (cached) return cached;

  const key = envKey('NEON_DATA_PROJECT_ID', region);
  let value = process.env[key];

  // Legacy fallback: 'local' region uses the non-suffixed env var so dev keeps working.
  if (!value && region === 'local') value = process.env.NEON_DATA_PROJECT_ID;

  if (!value) throw new Error(`Missing env var ${key} for region ${region}`);
  dataCache.set(region, value);
  return value;
}

export function getRuntimeProjectIdForRegion(region: string): string {
  const cached = runtimeCache.get(region);
  if (cached) return cached;

  const key = envKey('NEON_RUNTIME_PROJECT_ID', region);
  let value = process.env[key];
  if (!value && region === 'local') value = process.env.NEON_RUNTIME_PROJECT_ID;

  if (!value) throw new Error(`Missing env var ${key} for region ${region}`);
  runtimeCache.set(region, value);
  return value;
}

/**
 * Butterbase region → Neon `region_id` for project creation.
 * Neon ids look like `aws-us-east-1`; our regions look like `us-east-1`,
 * so the default is a prefix. Override per-region when a region lives on
 * a different cloud.
 */
export function getNeonRegionIdForRegion(region: string): string {
  const explicit = process.env[envKey('NEON_REGION', region)];
  if (explicit) return explicit;
  return `aws-${region}`;
}

/**
 * Postgres major version to use when creating a tenant project in `region`.
 * Regions can run different major versions on their shared data project
 * (e.g. us-east-1 is on PG 17, us-west-2 is on PG 18); a new tenant project
 * MUST match its region's neighbours, not a single global default. Reads
 * env directly on every call — no caching, matching getNeonRegionIdForRegion.
 */
export function getNeonPgVersionForRegion(region: string): number {
  const raw = process.env[envKey('NEON_PG_VERSION', region)];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return config.neon.pgVersion;
}

export function assertNeonProjectsConfig(): void {
  const regionsRaw = process.env.BUTTERBASE_REGIONS ?? '';
  const regions = regionsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (regions.length === 0) {
    throw new Error('BUTTERBASE_REGIONS is empty — at least one region is required');
  }
  for (const r of regions) {
    getDataProjectIdForRegion(r);
    getRuntimeProjectIdForRegion(r);
  }
}

/** Test-only: clears the in-process cache. Do not use in production code paths. */
export function __resetNeonProjectsCache(): void {
  dataCache.clear();
  runtimeCache.clear();
}
