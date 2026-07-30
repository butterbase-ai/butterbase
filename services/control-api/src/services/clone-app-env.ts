import type { Pool } from 'pg';
import { decrypt, encrypt } from './crypto.js';

export interface AppEnvReplayResult {
  copied: boolean;
  keyCount: number;
}

/**
 * Copy the source app's app-level env vars to the dest app. Runs before
 * replayFunctions and replayDurableObjectsForClone in executeClone so both
 * downstream replays see the merged blob at first deploy.
 */
export async function replayAppEnvVars(
  sourceDb: Pool,
  destDb: Pool,
  sourceAppId: string,
  destAppId: string,
  updatedByUserId: string,
): Promise<AppEnvReplayResult> {
  const encKey = process.env.AUTH_ENCRYPTION_KEY;
  if (!encKey) throw new Error('AUTH_ENCRYPTION_KEY not configured');

  const src = await sourceDb.query<{ encrypted_env_vars: string }>(
    `SELECT encrypted_env_vars FROM app_env_vars WHERE app_id = $1`,
    [sourceAppId],
  );
  if (src.rows.length === 0) return { copied: false, keyCount: 0 };

  let decoded: Record<string, string>;
  try {
    decoded = JSON.parse(decrypt(src.rows[0].encrypted_env_vars, encKey));
  } catch {
    return { copied: false, keyCount: 0 };
  }

  const encrypted = encrypt(JSON.stringify(decoded), encKey);
  await destDb.query(
    `INSERT INTO app_env_vars (app_id, encrypted_env_vars, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (app_id) DO UPDATE
       SET encrypted_env_vars = EXCLUDED.encrypted_env_vars,
           updated_at         = now(),
           updated_by         = EXCLUDED.updated_by`,
    [destAppId, encrypted, updatedByUserId],
  );
  return { copied: true, keyCount: Object.keys(decoded).length };
}
