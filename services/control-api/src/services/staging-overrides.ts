import type pg from 'pg';
import { encrypt, decrypt } from './crypto.js';

function key(): string {
  const k = process.env.AUTH_ENCRYPTION_KEY;
  if (!k) throw new Error('AUTH_ENCRYPTION_KEY not configured');
  return k;
}

export async function setStagingOverrides(
  runtimeDb: pg.Pool,
  stagingAppId: string,
  values: Record<string, string>,
  updatedBy: string,
): Promise<void> {
  const encrypted = encrypt(JSON.stringify(values), key());
  await runtimeDb.query(
    `INSERT INTO staging_env_overrides (staging_app_id, encrypted_overrides, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (staging_app_id) DO UPDATE
       SET encrypted_overrides = EXCLUDED.encrypted_overrides,
           updated_by          = EXCLUDED.updated_by,
           updated_at          = now()`,
    [stagingAppId, encrypted, updatedBy],
  );
}

export async function getStagingOverrides(
  runtimeDb: pg.Pool, stagingAppId: string,
): Promise<Record<string, string>> {
  const res = await runtimeDb.query<{ encrypted_overrides: string }>(
    `SELECT encrypted_overrides FROM staging_env_overrides WHERE staging_app_id = $1`,
    [stagingAppId],
  );
  if (res.rows.length === 0) return {};

  // Read the key BEFORE the try. A missing or rotated AUTH_ENCRYPTION_KEY is a
  // service misconfiguration and must halt; only an unreadable stored blob is
  // tolerable. Catching both alike would make a broken deploy look exactly like
  // "no overrides set", silently falling the staging app back to the production
  // values these overrides exist to replace.
  const encKey = key();
  try {
    return JSON.parse(decrypt(res.rows[0].encrypted_overrides, encKey));
  } catch {
    // Mirrors replayAppEnvVars: an undecryptable blob is treated as absent
    // rather than crashing the replay that reads it.
    return {};
  }
}

export function mergeStagingOverrides(
  inherited: Record<string, string>, overrides: Record<string, string>,
): Record<string, string> {
  return { ...inherited, ...overrides };
}

/**
 * Materialise the owner's overrides into the staging app's LIVE
 * `app_env_vars` blob, so they take effect without waiting for the next
 * clone-time replay.
 *
 * Why this exists as well as the `replayAppEnvVars` hook: the runtime reads
 * `app_env_vars` directly (services/deno-runtime/function-loader.ts joins it
 * onto `app_functions`), and `staging_env_overrides.staging_app_id` REFERENCES
 * `apps(id)` — so an override cannot exist before the staging app does, and
 * the clone-time hook can therefore never be the only application point.
 * Setting an override has to write through to the blob at set time.
 *
 * MERGE, not replace: overrides are layered over whatever the staging app
 * currently holds (values the owner set directly via `PATCH /v1/:appId/env`
 * are preserved unless an override names the same key). Overrides win.
 * Returns key NAMES only — never a value.
 */
export async function applyStagingOverridesToAppEnv(
  runtimeDb: pg.Pool,
  stagingAppId: string,
  overrides: Record<string, string>,
  updatedBy: string,
): Promise<{ appliedKeys: string[] }> {
  const encKey = key();
  const existing = await runtimeDb.query<{ encrypted_env_vars: string }>(
    `SELECT encrypted_env_vars FROM app_env_vars WHERE app_id = $1`,
    [stagingAppId],
  );
  let current: Record<string, string> = {};
  if (existing.rows[0]?.encrypted_env_vars) {
    try {
      current = JSON.parse(decrypt(existing.rows[0].encrypted_env_vars, encKey));
    } catch {
      // Mirrors routes/app-env.ts's PATCH handler: an undecryptable blob is
      // rebuilt rather than treated as fatal.
      current = {};
    }
  }
  const merged = mergeStagingOverrides(current, overrides);
  await runtimeDb.query(
    `INSERT INTO app_env_vars (app_id, encrypted_env_vars, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (app_id) DO UPDATE
       SET encrypted_env_vars = EXCLUDED.encrypted_env_vars,
           updated_at         = now(),
           updated_by         = EXCLUDED.updated_by`,
    [stagingAppId, encrypt(JSON.stringify(merged), encKey), updatedBy],
  );
  return { appliedKeys: Object.keys(overrides) };
}
