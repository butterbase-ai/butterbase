export class RegionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegionConfigError';
  }
}

const REGION_PATTERN = /^[a-z]+(-[a-z0-9]+)+$/;

export function parseRegions(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new RegionConfigError('BUTTERBASE_REGIONS is empty');
  }
  const items = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) {
    throw new RegionConfigError('BUTTERBASE_REGIONS contained no usable values');
  }
  for (const item of items) {
    if (!REGION_PATTERN.test(item)) {
      throw new RegionConfigError(
        `Invalid region "${item}". Expected lowercase, hyphen-separated (e.g. us-east-1).`
      );
    }
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) {
      throw new RegionConfigError(`Duplicate region in BUTTERBASE_REGIONS: ${item}`);
    }
    seen.add(item);
  }
  return items;
}

export function parseInstanceRegion(raw: string, allowed: string[]): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new RegionConfigError('BUTTERBASE_REGION is empty');
  }
  if (!allowed.includes(trimmed)) {
    throw new RegionConfigError(
      `BUTTERBASE_REGION "${trimmed}" is not in BUTTERBASE_REGIONS [${allowed.join(',')}]`
    );
  }
  return trimmed;
}

export interface RegionConfig {
  regions: string[];
  instanceRegion: string;
}

export function parseFlyRegionMap(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new RegionConfigError('BUTTERBASE_FLY_REGION_MAP is empty');
  }
  const entries = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  const map: Record<string, string> = {};
  for (const entry of entries) {
    const idx = entry.indexOf(':');
    if (idx <= 0 || idx === entry.length - 1) {
      throw new RegionConfigError(
        `Malformed entry "${entry}" in BUTTERBASE_FLY_REGION_MAP. Expected format: <fly_region>:<butterbase_region>`
      );
    }
    const flyRegion = entry.slice(0, idx).trim();
    const butterbaseRegion = entry.slice(idx + 1).trim();
    if (!flyRegion || !butterbaseRegion) {
      throw new RegionConfigError(`Empty key or value in entry "${entry}"`);
    }
    if (map[flyRegion] !== undefined) {
      throw new RegionConfigError(`Duplicate Fly region key "${flyRegion}" in BUTTERBASE_FLY_REGION_MAP`);
    }
    map[flyRegion] = butterbaseRegion;
  }
  return map;
}

export function loadRegionConfig(env: Record<string, string | undefined>): RegionConfig {
  const regionsRaw = env.BUTTERBASE_REGIONS;
  if (regionsRaw === undefined) {
    throw new RegionConfigError('BUTTERBASE_REGIONS env var is not set');
  }
  const regions = parseRegions(regionsRaw);

  // Resolution order:
  //   1. Explicit BUTTERBASE_REGION (operator override / local dev)
  //   2. Derive from FLY_REGION via BUTTERBASE_FLY_REGION_MAP (production on Fly)
  let instanceRegion: string;
  const explicit = env.BUTTERBASE_REGION;
  if (explicit !== undefined) {
    const stripped = explicit.trim();
    if (!stripped) {
      throw new RegionConfigError('BUTTERBASE_REGION is set but empty');
    }
    instanceRegion = parseInstanceRegion(stripped, regions);
  } else {
    const flyRegion = env.FLY_REGION;
    const mapRaw = env.BUTTERBASE_FLY_REGION_MAP;
    if (!flyRegion || !mapRaw) {
      throw new RegionConfigError(
        'BUTTERBASE_REGION env var is not set, and no FLY_REGION + BUTTERBASE_FLY_REGION_MAP available to derive from'
      );
    }
    const map = parseFlyRegionMap(mapRaw);
    const derived = map[flyRegion];
    if (!derived) {
      throw new RegionConfigError(
        `FLY_REGION "${flyRegion}" has no entry in BUTTERBASE_FLY_REGION_MAP`
      );
    }
    instanceRegion = parseInstanceRegion(derived, regions);
  }

  return { regions, instanceRegion };
}

export function regionToEnvSuffix(region: string): string {
  return region.toUpperCase().replace(/-/g, '_');
}

/**
 * Given an AWS-style butterbase region (e.g. "us-west-2"), return the first
 * Fly region code (e.g. "sjc") configured to serve it via BUTTERBASE_FLY_REGION_MAP.
 * Fly load-balances across machines within the chosen fly region, so picking
 * the first match is sufficient. Returns null when no fly region maps to the
 * given butterbase region.
 */
export function butterbaseRegionToFlyRegion(
  butterbaseRegion: string,
  flyRegionMap: Record<string, string>,
): string | null {
  for (const [fly, bb] of Object.entries(flyRegionMap)) {
    if (bb === butterbaseRegion) return fly;
  }
  return null;
}
