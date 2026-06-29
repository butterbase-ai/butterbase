import type { Pool } from 'pg';
import type { ProfilePayload } from './types.js';

const TTL_OK_DAYS = 30;
const TTL_NOT_FOUND_DAYS = 7;
const TTL_FAILED_HOURS = 1;

export async function lookupCachedProfile(
  runtime: Pool,
  appId: string,
  normalizedUrl: string,
): Promise<{ status: 'ok' | 'not_found'; payload: ProfilePayload | null } | null> {
  const r = await runtime.query<{ status: 'ok' | 'not_found' | 'failed'; payload_jsonb: unknown }>(
    `SELECT status, payload_jsonb FROM enrichlayer_profile_cache
       WHERE app_id = $1 AND normalized_url = $2 AND expires_at > now()`,
    [appId, normalizedUrl],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  if (row.status === 'failed') return null; // treat as miss; let caller re-try
  return { status: row.status, payload: (row.payload_jsonb ?? null) as ProfilePayload | null };
}

export async function writeCachedProfile(
  runtime: Pool,
  appId: string,
  normalizedUrl: string,
  status: 'ok' | 'not_found' | 'failed',
  payload: ProfilePayload | null,
): Promise<void> {
  const ttlExpr =
    status === 'ok'
      ? `now() + interval '${TTL_OK_DAYS} days'`
      : status === 'not_found'
        ? `now() + interval '${TTL_NOT_FOUND_DAYS} days'`
        : `now() + interval '${TTL_FAILED_HOURS} hours'`;
  await runtime.query(
    `INSERT INTO enrichlayer_profile_cache (app_id, normalized_url, status, payload_jsonb, expires_at)
       VALUES ($1, $2, $3, $4, ${ttlExpr})
     ON CONFLICT (app_id, normalized_url) DO UPDATE
       SET status = EXCLUDED.status,
           payload_jsonb = EXCLUDED.payload_jsonb,
           fetched_at = now(),
           expires_at = EXCLUDED.expires_at`,
    [appId, normalizedUrl, status, payload],
  );
}
