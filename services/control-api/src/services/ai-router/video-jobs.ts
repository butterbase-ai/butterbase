import type pg from 'pg';

export interface VideoJobRow {
  id: string;
  app_id: string;
  user_id: string;
  /**
   * End-user subject from the app-scoped JWT that submitted this job.
   * NULL when submitted by the app owner or an app-scoped API key.
   * GETs by an end-user JWT are restricted to rows matching their own sub.
   */
  end_user_sub: string | null;
  model: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';
  /**
   * Original submit-time body (the VideoGenerationRequest the caller sent).
   * Stored so the settle path can recover request shape — `resolution`,
   * `input_images`, `input_references` — for the per-request variant match
   * in estimateVideoCostUsd when the upstream doesn't return a cost on poll.
   */
  request_json: Record<string, unknown>;
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
    /** End-user sub when submitted via app-scoped JWT; NULL otherwise. */
    endUserSub: string | null;
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
       (app_id, user_id, end_user_sub, model, request_json, status,
        upstream_router, upstream_job_id, upstream_polling_url,
        lease_id, estimated_cost_usd, markup_pct)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      args.appId, args.userId, args.endUserSub, args.model, args.requestJson,
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
