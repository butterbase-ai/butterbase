import type pg from 'pg';
import { decrypt } from './crypto.js';

export interface SourceFnEnvVarKeys {
  fn_name: string;
  keys: string[];
}

/**
 * Minimal logger shape compatible with pino's warn(obj, msg). console works too
 * — falls back to console when no logger is provided so the helper stays usable
 * from one-off scripts and tests.
 */
export interface CloneEnvVarsLogger {
  warn(obj: unknown, msg?: string): void;
}

const defaultLogger: CloneEnvVarsLogger = {
  warn: (obj, msg) => console.warn(msg ?? '[clone-env-vars]', obj),
};

/**
 * Read every non-deleted function on the source app, decrypt encrypted_env_vars
 * with the platform AUTH_ENCRYPTION_KEY, and return the KEY NAMES only. Functions
 * with no encrypted env vars are omitted entirely so the caller's "needs values"
 * list is empty when nothing needs filling.
 *
 * Decrypt failures (key rotation, corrupted blob) are logged and the offending
 * function is skipped — a silent drop would mask a misconfiguration where every
 * function decrypts to nothing and the preflight reports `[]`.
 */
export async function listSourceEnvVarKeys(
  sourceRuntimePool: pg.Pool,
  sourceAppId: string,
  logger: CloneEnvVarsLogger = defaultLogger,
): Promise<SourceFnEnvVarKeys[]> {
  const key = process.env.AUTH_ENCRYPTION_KEY;
  if (!key) throw new Error('AUTH_ENCRYPTION_KEY not configured');

  const res = await sourceRuntimePool.query<{ name: string; encrypted_env_vars: string | null }>(
    `SELECT name, encrypted_env_vars
       FROM app_functions
      WHERE app_id = $1 AND deleted_at IS NULL AND encrypted_env_vars IS NOT NULL`,
    [sourceAppId],
  );

  const out: SourceFnEnvVarKeys[] = [];
  for (const row of res.rows) {
    try {
      const decoded = JSON.parse(decrypt(row.encrypted_env_vars!, key)) as Record<string, unknown>;
      const keys = Object.keys(decoded);
      if (keys.length > 0) out.push({ fn_name: row.name, keys });
    } catch (err) {
      logger.warn(
        { err, sourceAppId, fnName: row.name },
        '[clone] failed to decrypt encrypted_env_vars; skipping function',
      );
    }
  }
  return out;
}

export interface DetectedConvention {
  key: string;
  convention: 'butterbase_api_key';
  auto_mintable: boolean;
}

const CONVENTIONS: Record<string, DetectedConvention['convention']> = {
  BUTTERBASE_API_KEY: 'butterbase_api_key',
};

/**
 * Inspect a list of env var key names and surface platform-recognized conventions
 * the caller can opt into (e.g. auto-minting a scoped bb_sk_* for BUTTERBASE_API_KEY).
 */
export function detectConventions(keys: string[]): DetectedConvention[] {
  return keys
    .filter(k => k in CONVENTIONS)
    .map(k => ({ key: k, convention: CONVENTIONS[k], auto_mintable: true }));
}
