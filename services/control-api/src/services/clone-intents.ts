import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { encrypt, decrypt } from './crypto.js';

export const CLONE_INTENT_TTL_MS = 60 * 60 * 1000;

export interface CloneIntent {
  id: string;
  source_app_id: string;
  dest_app_name: string | null;
  dest_region: string | null;
  auto_mint_requests: { fn_name: string; key: string }[] | null;
  created_at: Date;
  expires_at: Date;
  redeemed_at: Date | null;
  redeemed_by_user_id: string | null;
  resulting_job_id: string | null;
}

interface IntentRow extends CloneIntent {
  encrypted_env_values: string | null;
}

export async function createCloneIntent(
  controlDb: pg.Pool,
  args: {
    sourceAppId: string;
    destAppName?: string;
    destRegion?: string;
    envVarValues?: Record<string, Record<string, string>>;
    autoMintRequests?: { fn_name: string; key: string }[];
    sourceIp?: string;
  },
): Promise<{ id: string; expires_at: Date }> {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + CLONE_INTENT_TTL_MS);

  let encrypted: string | null = null;
  if (args.envVarValues && Object.keys(args.envVarValues).length > 0) {
    const keyHex = process.env.AUTH_ENCRYPTION_KEY;
    if (!keyHex) throw new Error('AUTH_ENCRYPTION_KEY not configured');
    encrypted = encrypt(JSON.stringify(args.envVarValues), keyHex);
  }

  await controlDb.query(
    `INSERT INTO template_clone_intents
       (id, source_app_id, dest_app_name, dest_region, encrypted_env_values,
        auto_mint_requests, expires_at, source_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      args.sourceAppId,
      args.destAppName ?? null,
      args.destRegion ?? null,
      encrypted,
      args.autoMintRequests ? JSON.stringify(args.autoMintRequests) : null,
      expiresAt,
      args.sourceIp ?? null,
    ],
  );
  return { id, expires_at: expiresAt };
}

export async function loadRedeemableIntent(
  controlDb: pg.Pool,
  id: string,
): Promise<
  | { ok: true; intent: CloneIntent; envVarValues?: Record<string, Record<string, string>> }
  | { ok: false; reason: 'not_found' | 'expired' }
  | { ok: false; reason: 'already_redeemed'; jobId: string | null }
> {
  const r = await controlDb.query<IntentRow>(
    `SELECT * FROM template_clone_intents WHERE id = $1`, [id],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.redeemed_at) {
    return { ok: false, reason: 'already_redeemed', jobId: row.resulting_job_id };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  let envVarValues: Record<string, Record<string, string>> | undefined;
  if (row.encrypted_env_values) {
    const keyHex = process.env.AUTH_ENCRYPTION_KEY;
    if (!keyHex) throw new Error('AUTH_ENCRYPTION_KEY not configured');
    envVarValues = JSON.parse(decrypt(row.encrypted_env_values, keyHex));
  }

  const { encrypted_env_values: _omit, ...intent } = row;
  return { ok: true, intent, envVarValues };
}

export async function markIntentRedeemed(
  controlDb: pg.Pool,
  args: { id: string; userId: string; jobId: string },
): Promise<boolean> {
  // Guard against concurrent redemption with AND redeemed_at IS NULL.
  // The UPDATE is the single point of serialization since callers hold a Pool,
  // not a locked row. Returns true if this call claimed the intent, false if
  // a concurrent call won the race.
  const r = await controlDb.query(
    `UPDATE template_clone_intents
        SET redeemed_at = now(),
            redeemed_by_user_id = $2,
            resulting_job_id = $3,
            encrypted_env_values = NULL
      WHERE id = $1 AND redeemed_at IS NULL`,
    [args.id, args.userId, args.jobId],
  );
  return r.rowCount > 0;
}
