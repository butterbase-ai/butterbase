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
  try {
    return JSON.parse(decrypt(res.rows[0].encrypted_overrides, key()));
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
