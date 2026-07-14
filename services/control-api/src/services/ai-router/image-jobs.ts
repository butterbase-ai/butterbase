import type pg from 'pg';
import { resolveOrgFromApp } from '../app-org-resolver.js';

export interface ImageJobRow {
  id: string;
  app_id: string;
  organization_id: string;
  user_id: string;
  end_user_sub: string | null;
  model: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';
  request_json: Record<string, unknown>;
  upstream_router: string;
  upstream_job_id: string;
  upstream_polling_url: string;
  unsigned_urls: string[] | null;
  content_type: string | null;
  error: string | null;
  lease_id: string;
  estimated_cost_usd: string;
  provider_cost_usd: string | null;
  charged_credits_usd: string | null;
  markup_pct: string;
  settled_at: Date | null;
  created_at: Date;
}

export async function insertImageJob(
  pool: pg.Pool,
  args: {
    appId: string;
    userId: string;
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
  const organizationId = await resolveOrgFromApp(pool, args.appId);
  const r = await pool.query<{ id: string }>(
    `INSERT INTO ai_image_jobs
       (app_id, user_id, end_user_sub, model, request_json, status,
        upstream_router, upstream_job_id, upstream_polling_url,
        lease_id, estimated_cost_usd, markup_pct, organization_id)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      args.appId, args.userId, args.endUserSub, args.model, args.requestJson,
      args.upstreamRouter, args.upstreamJobId, args.upstreamPollingUrl,
      args.leaseId, args.estimatedCostUsd, args.markupPct,
      organizationId,
    ],
  );
  return r.rows[0].id;
}

export async function getImageJob(pool: pg.Pool, id: string): Promise<ImageJobRow | null> {
  const r = await pool.query<ImageJobRow>(`SELECT * FROM ai_image_jobs WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function markImageJobInProgress(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE ai_image_jobs SET status = 'in_progress', updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
    [id],
  );
}

export async function markImageJobTerminal(
  pool: pg.Pool,
  id: string,
  args: {
    status: 'completed' | 'failed' | 'cancelled' | 'expired';
    unsignedUrls?: string[];
    contentType?: string;
    providerCostUsd?: number;
    chargedCreditsUsd?: number;
    error?: string;
  },
): Promise<{ firstTerminal: boolean }> {
  const r = await pool.query<{ id: string }>(
    `UPDATE ai_image_jobs
       SET status = $2,
           unsigned_urls = $3,
           content_type = $4,
           provider_cost_usd = $5,
           charged_credits_usd = $6,
           error = $7,
           settled_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND settled_at IS NULL
       RETURNING id`,
    [
      id, args.status,
      args.unsignedUrls != null ? JSON.stringify(args.unsignedUrls) : null,
      args.contentType ?? null,
      args.providerCostUsd ?? null,
      args.chargedCreditsUsd ?? null,
      args.error ?? null,
    ],
  );
  return { firstTerminal: r.rowCount === 1 };
}
