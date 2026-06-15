import type pg from 'pg';
import { decrypt } from './crypto.js';
import { ApiKeyService } from './api-key-service.js';

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

// Both keys mint the SAME credential shape — a bb_sk_* scoped to the dest app.
// Every bb_sk_ carries substrate_user_id = owner, so it works on both the app
// plane (BUTTERBASE_API_KEY) and the caller's substrate (BB_SUBSTRATE_KEY).
// See api-key-service.ts:42-45 for the cross-surface guarantee.
const CONVENTIONS: Record<string, DetectedConvention['convention']> = {
  BUTTERBASE_API_KEY: 'butterbase_api_key',
  BB_SUBSTRATE_KEY: 'butterbase_api_key',
};

/** Names of convention keys that the clone flow auto-mints by default
 *  (no `auto_mint_api_key` opt-in required from the caller). */
export const AUTO_MINT_CONVENTION_KEYS = Object.keys(CONVENTIONS);

/**
 * Deterministic per-clone fills. Unlike CONVENTIONS, these are not secrets —
 * they're values the platform already knows at clone time. The cloner should
 * never have to type these into the env-vars banner.
 *
 *   BUTTERBASE_API_URL — public control-api URL
 *   BUTTERBASE_APP_ID  — the dest app's id
 *
 * Resolution is centralized here so the same value lands in every receiver
 * (functions, dashboards, frontends) and so tests can stub it cheaply.
 */
export function resolveStaticFills(
  args: { destAppId: string; apiBaseUrl: string },
): Record<string, string> {
  return {
    BUTTERBASE_API_URL: args.apiBaseUrl,
    BUTTERBASE_APP_ID: args.destAppId,
  };
}

/** Names of static-fill keys. Convenience for tests + the dashboard. */
export const STATIC_FILL_KEYS = ['BUTTERBASE_API_URL', 'BUTTERBASE_APP_ID'];

/**
 * Inspect a list of env var key names and surface platform-recognized conventions
 * the caller can opt into (e.g. auto-minting a scoped bb_sk_* for BUTTERBASE_API_KEY).
 */
export function detectConventions(keys: string[]): DetectedConvention[] {
  return keys
    .filter(k => k in CONVENTIONS)
    .map(k => ({ key: k, convention: CONVENTIONS[k], auto_mintable: true }));
}

export interface MintedCloneKey {
  key: string;
  keyId: string;
}

/**
 * Mint a `bb_sk_*` API key for the dest app owner, scoped narrowly to the dest
 * app's AI gateway. Used when the user opts into auto-mint for the
 * BUTTERBASE_API_KEY convention. Scope is intentionally limited to
 * `app:<destAppId>` + `ai:gateway` so a leaked key cannot be repurposed.
 *
 * One key per cloned app (not per function). Functions on the same app
 * frequently call each other (cron fn calls ingest fn, ingest fn calls
 * enrichment fn, …) and any in-function caller-equality check on the bearer
 * (`req.headers.authorization === Bearer ctx.env.BUTTERBASE_API_KEY`) only
 * works when every function sees the same key. The `fnName` arg is accepted
 * but currently only used in the key's display name when supplied — multiple
 * call sites within a single clone job MUST pass the same key to every
 * function (use `mintSharedCloneKey` from replayFunctions).
 */
export async function mintApiKeyForClone(
  controlPool: pg.Pool,
  args: { ownerId: string; destAppId: string },
): Promise<MintedCloneKey> {
  // Produces ['app:<destAppId>', 'ai:gateway'] — the standard clone baseline.
  // If buildScopes's defaults for `keyScope: 'app'` ever change, review whether
  // clone-minted keys should pick up the new tokens here.
  const result = await ApiKeyService.generateApiKey(
    controlPool,
    args.ownerId,
    `Auto-mint for clone (${args.destAppId})`,
    {
      keyScope: 'app',
      targetAppId: args.destAppId,
      substrateAccess: 'app',
    },
  );
  return { key: result.key, keyId: result.keyId };
}
