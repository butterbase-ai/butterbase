import { randomBytes } from 'node:crypto';

// Layered onto function and DO env vars during clone replay. Populated from
// the CLONE_APP_ENV_OVERRIDES env var (JSON blob) so tenant-specific defaults
// never live in source. See docs/superpowers/specs/2026-07-16-clone-app-env-overrides-design.md.

export type OverrideSpec =
  | { type: 'mint_hex'; bytes: number }
  | { type: 'static'; value: string };

export type CloneAppOverrides = Record<string, Record<string, OverrideSpec>>;

const MIN_BYTES = 16;
const MAX_BYTES = 128;

function assertSpec(sourceAppId: string, key: string, raw: unknown): OverrideSpec {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `CLONE_APP_ENV_OVERRIDES[${sourceAppId}][${key}] must be an object`,
    );
  }
  const spec = raw as Record<string, unknown>;
  if (spec.type === 'mint_hex') {
    const bytes = spec.bytes;
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < MIN_BYTES || bytes > MAX_BYTES) {
      throw new Error(
        `CLONE_APP_ENV_OVERRIDES[${sourceAppId}][${key}].bytes must be an integer in [${MIN_BYTES}, ${MAX_BYTES}]`,
      );
    }
    return { type: 'mint_hex', bytes };
  }
  if (spec.type === 'static') {
    if (typeof spec.value !== 'string') {
      throw new Error(
        `CLONE_APP_ENV_OVERRIDES[${sourceAppId}][${key}].value must be a string`,
      );
    }
    return { type: 'static', value: spec.value };
  }
  throw new Error(
    `CLONE_APP_ENV_OVERRIDES[${sourceAppId}][${key}]: unknown override type ${JSON.stringify(spec.type)}`,
  );
}

export function parseCloneAppOverrides(raw: string | undefined): CloneAppOverrides {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`CLONE_APP_ENV_OVERRIDES: failed to parse JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`CLONE_APP_ENV_OVERRIDES: top-level must be a JSON object`);
  }
  const out: CloneAppOverrides = {};
  for (const [sourceAppId, byKey] of Object.entries(parsed as Record<string, unknown>)) {
    if (byKey === null || typeof byKey !== 'object' || Array.isArray(byKey)) {
      throw new Error(`CLONE_APP_ENV_OVERRIDES[${sourceAppId}] must be an object`);
    }
    out[sourceAppId] = {};
    for (const [key, raw] of Object.entries(byKey as Record<string, unknown>)) {
      out[sourceAppId][key] = assertSpec(sourceAppId, key, raw);
    }
  }
  return out;
}

export function resolveOverridesForClone(
  overrides: CloneAppOverrides,
  sourceAppId: string,
): Record<string, string> {
  const entry = overrides[sourceAppId];
  if (!entry) return {};
  const out: Record<string, string> = {};
  for (const [key, spec] of Object.entries(entry)) {
    if (spec.type === 'static') {
      out[key] = spec.value;
    } else {
      out[key] = randomBytes(spec.bytes).toString('hex');
    }
  }
  return out;
}

let cached: CloneAppOverrides | null = null;

export function getCloneAppOverrides(): CloneAppOverrides {
  if (cached === null) {
    cached = parseCloneAppOverrides(process.env.CLONE_APP_ENV_OVERRIDES);
  }
  return cached;
}

/** Reset the memoized singleton. Test-only. */
export function __resetForTests(): void {
  cached = null;
}
