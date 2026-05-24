import type pg from 'pg';

export interface VideoJobRow {
  id: string;
  app_id: string;
  user_id: string;
  model: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';
  upstream_router: string;
  upstream_job_id: string;
  upstream_polling_url: string;
  unsigned_urls: string[] | null;
  error: string | null;
  lease_id: string;
  estimated_cost_usd: string;
  provider_cost_usd: string | null;
  charged_credits_usd: string | null;
  markup_pct: string;
  settled_at: Date | null;
  created_at: Date;
}

export async function insertVideoJob(
  pool: pg.Pool,
  args: {
    appId: string;
    userId: string;
    model: string;
    requestJson: unknown;
    upstreamRouter: string;
    upstreamJobId: string;
    upstreamPollingUrl: string;
    leaseId: string;
    estimatedCostUsd: number;
    markupPct: number;
  },
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO ai_video_jobs
       (app_id, user_id, model, request_json, status,
        upstream_router, upstream_job_id, upstream_polling_url,
        lease_id, estimated_cost_usd, markup_pct)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      args.appId, args.userId, args.model, args.requestJson,
      args.upstreamRouter, args.upstreamJobId, args.upstreamPollingUrl,
      args.leaseId, args.estimatedCostUsd, args.markupPct,
    ],
  );
  return r.rows[0].id;
}

export async function getVideoJob(pool: pg.Pool, id: string): Promise<VideoJobRow | null> {
  const r = await pool.query<VideoJobRow>(`SELECT * FROM ai_video_jobs WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function markVideoJobInProgress(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE ai_video_jobs SET status = 'in_progress', updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
    [id],
  );
}

/**
 * Atomically transition a job to a terminal state and record billing settlement.
 * Returns `firstTerminal: true` exactly once per job (the row that actually moved
 * the status). Use that signal to drive lease settlement so it runs only once.
 */
export async function markVideoJobTerminal(
  pool: pg.Pool,
  id: string,
  args: {
    status: 'completed' | 'failed' | 'cancelled' | 'expired';
    unsignedUrls?: string[];
    providerCostUsd?: number;
    chargedCreditsUsd?: number;
    error?: string;
  },
): Promise<{ firstTerminal: boolean }> {
  const r = await pool.query<{ id: string }>(
    `UPDATE ai_video_jobs
       SET status = $2,
           unsigned_urls = $3,
           provider_cost_usd = $4,
           charged_credits_usd = $5,
           error = $6,
           settled_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND settled_at IS NULL
       RETURNING id`,
    [
      id, args.status,
      args.unsignedUrls != null ? JSON.stringify(args.unsignedUrls) : null,
      args.providerCostUsd ?? null, args.chargedCreditsUsd ?? null,
      args.error ?? null,
    ],
  );
  return { firstTerminal: r.rowCount === 1 };
}
