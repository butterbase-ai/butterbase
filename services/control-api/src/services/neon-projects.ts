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
