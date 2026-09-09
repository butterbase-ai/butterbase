import type { Pool } from 'pg';
import { decrypt, encrypt } from './crypto.js';

export interface AppEnvReplayResult {
  copied: boolean;
  keyCount: number;
  /**
   * Inherited keys whose PRODUCTION VALUE was deliberately not carried across —
   * seeded as an empty string instead. Names only; a value never appears here.
   *
   * Only populated when `opts.withholdInheritedValues` is set, so the default
   * clone / template-update / public-template result is byte-identical to the
   * pre-opts baseline (vitest `toEqual` ignores `undefined` properties).
   */
  withheldKeys?: string[];
  /** Inherited keys that an override replaced. Names only. */
  overriddenKeys?: string[];
}

/**
 * Additive, opt-in behaviour switches — the same shape as clone-replay.ts's
 * `preserveDestinationTriggerEnabled` / `skipIntegrations` / `throwOnFailure` /
 * `warnOnZeroRewrite`. With `opts` omitted (or empty) this function behaves
 * exactly as it did before these options existed, so the clone, template-update
 * and public-template paths are unaffected.
 */
export interface ReplayAppEnvVarsOpts {
  /**
   * Owner-supplied values layered ON TOP of the inherited blob — an override
   * always wins over the value inherited from the source app. Read from
   * `staging_env_overrides` (staging-overrides.ts) by the caller.
   */
  overrides?: Record<string, string>;
  /**
   * Do not carry any inherited VALUE across; seed every inherited key as an
   * empty string so the key NAME survives (the owner can see what needs
   * filling via `GET /v1/:appId/env`) while the production credential does
   * not.
   *
   * This is the staging default. A staging app that silently holds
   * production's live Stripe/SendGrid keys will charge real cards from an
   * HTTP-triggered function; a staging app whose functions throw
   * "missing API key" is annoying, obvious and recoverable. There is no
   * reliable way to tell a "secret-shaped" key from a harmless one by name or
   * value prefix — any heuristic has false negatives, and a false negative
   * here IS the incident — so nothing is carried across rather than the
   * subset a regex happens to recognise.
   */
  withholdInheritedValues?: boolean;
}

/**
 * Copy the source app's app-level env vars to the dest app. Runs before
 * replayFunctions and replayDurableObjectsForClone in executeClone so both
 * downstream replays see the merged blob at first deploy.
 *
 * NOTE: this is the ONLY path by which a source app's secret VALUES reach a
 * clone destination — replayFunctions blanks per-function `encrypted_env_vars`
 * and replayDurableObjectsForClone copies DO env KEYS only. That makes this the
 * single seam where staging's inheritance of production credentials has to be
 * decided; see `ReplayAppEnvVarsOpts.withholdInheritedValues`.
 */
export async function replayAppEnvVars(
  sourceDb: Pool,
  destDb: Pool,
  sourceAppId: string,
  destAppId: string,
  updatedByUserId: string,
  opts?: ReplayAppEnvVarsOpts,
): Promise<AppEnvReplayResult> {
  const encKey = process.env.AUTH_ENCRYPTION_KEY;
  if (!encKey) throw new Error('AUTH_ENCRYPTION_KEY not configured');

  const overrides = opts?.overrides ?? {};
  const hasOverrides = Object.keys(overrides).length > 0;
  const withhold = opts?.withholdInheritedValues === true;

  const src = await sourceDb.query<{ encrypted_env_vars: string }>(
    `SELECT encrypted_env_vars FROM app_env_vars WHERE app_id = $1`,
    [sourceAppId],
  );
  // Source has nothing to inherit. Overrides may still be worth writing (the
  // owner set a value for a key production doesn't define), so only take the
  // historical early return when there is genuinely nothing to write.
  if (src.rows.length === 0 && !hasOverrides) return { copied: false, keyCount: 0 };

  let decoded: Record<string, string> = {};
  if (src.rows.length > 0) {
    try {
      decoded = JSON.parse(decrypt(src.rows[0].encrypted_env_vars, encKey));
    } catch {
      // An undecryptable source blob is treated as absent rather than fatal.
      if (!hasOverrides) return { copied: false, keyCount: 0 };
      decoded = {};
    }
  }

  let inherited = decoded;
  let withheldKeys: string[] | undefined;
  if (withhold) {
    inherited = {};
    withheldKeys = [];
    for (const k of Object.keys(decoded)) {
      inherited[k] = '';
      if (!(k in overrides)) withheldKeys.push(k);
    }
  }

  // Overrides win over whatever the inherited layer produced.
  const finalValues: Record<string, string> = { ...inherited, ...overrides };
  const overriddenKeys = hasOverrides
    ? Object.keys(overrides).filter((k) => k in decoded)
    : undefined;

  const encrypted = encrypt(JSON.stringify(finalValues), encKey);
  await destDb.query(
    `INSERT INTO app_env_vars (app_id, encrypted_env_vars, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (app_id) DO UPDATE
       SET encrypted_env_vars = EXCLUDED.encrypted_env_vars,
           updated_at         = now(),
           updated_by         = EXCLUDED.updated_by`,
    [destAppId, encrypted, updatedByUserId],
  );
  return {
    copied: true,
    keyCount: Object.keys(finalValues).length,
    ...(withheldKeys ? { withheldKeys } : {}),
    ...(overriddenKeys && overriddenKeys.length > 0 ? { overriddenKeys } : {}),
  };
}

/**
 * The join between "what mode is this clone job" and "how are the source app's
 * env var values treated". Extracted so the decision is nameable and testable
 * on its own — the original defect was not inside either half but in the gap
 * between them: `replayAppEnvVars` copied production's secrets and the staging
 * override store had no caller, and nothing asserted that the staging MODE
 * changed the replay's behaviour at all.
 *
 * Returns `undefined` for every non-staging mode, so `replayAppEnvVars` runs
 * its historical default path unchanged for clone / update / public-template /
 * promote.
 */
export function appEnvReplayOptsForCloneMode(
  mode: string,
  stagingOverrides?: Record<string, string>,
): ReplayAppEnvVarsOpts | undefined {
  if (mode !== 'staging_create') return undefined;
  return { overrides: stagingOverrides ?? {}, withholdInheritedValues: true };
}
