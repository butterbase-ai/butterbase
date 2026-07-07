import pg from 'pg';
import { randomBytes } from 'crypto';
import { encrypt } from './crypto.js';

export type CloneJobStatus =
  | 'pending'
  | 'processing'
  | 'replaying_schema'
  | 'replaying_rls'
  | 'replaying_functions'
  | 'replaying_config'
  | 'copying_repo'
  | 'seeding_data'
  | 'completed'
  | 'failed';

/**
 * Statuses at which the pipeline is finished for good. Any other status —
 * including mid-flight ones like 'replaying_rls' — is resumable and must NOT
 * short-circuit executeClone on retry (see neon-task-worker.ts). A prior
 * version of the re-entry guard treated everything except 'pending'/'processing'
 * as terminal, which silently orphaned jobs after their first mid-stage crash.
 */
export const TERMINAL_CLONE_STATUSES: ReadonlyArray<CloneJobStatus> = ['completed', 'failed'];

export function isTerminalCloneStatus(status: CloneJobStatus): boolean {
  return TERMINAL_CLONE_STATUSES.includes(status);
}

export interface CloneJob {
  id: string;
  source_app_id: string;
  source_snapshot_id: string;
  source_region: string;
  dest_app_id: string | null;
  dest_region: string;
  requested_by_user_id: string;
  dest_organization_id: string | null;
  dest_app_name: string | null;
  status: CloneJobStatus;
  retry_count: number;
  error_message: string | null;
  warnings: string[] | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  pending_env_vars: string | null;       // encrypted JSON blob (AUTH_ENCRYPTION_KEY)
  auto_mint_requests: { fn_name: string; key: string }[] | null;
  unfilled_env_vars: Record<string, string[]> | null;
}

function generateJobId(): string {
  // 'cj_' + 24 url-safe chars (base64url, no padding)
  return 'cj_' + randomBytes(18).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function createCloneJob(
  controlDb: pg.Pool,
  args: {
    sourceAppId: string;
    sourceSnapshotId: string;
    sourceRegion: string;
    destRegion: string;
    requestedByUserId: string;
    destOrganizationId: string;
    destAppName?: string;
    pendingEnvVarValues?: Record<string, Record<string, string>>;
    autoMintRequests?: { fn_name: string; key: string }[];
  },
): Promise<CloneJob> {
  const id = generateJobId();

  let pendingEnvVars: string | null = null;
  if (args.pendingEnvVarValues && Object.keys(args.pendingEnvVarValues).length > 0) {
    const keyHex = process.env.AUTH_ENCRYPTION_KEY;
    if (!keyHex) throw new Error('AUTH_ENCRYPTION_KEY not configured');
    pendingEnvVars = encrypt(JSON.stringify(args.pendingEnvVarValues), keyHex);
  }

  let autoMintRequests: string | null = null;
  if (args.autoMintRequests && args.autoMintRequests.length > 0) {
    autoMintRequests = JSON.stringify(args.autoMintRequests);
  }

  const res = await controlDb.query<CloneJob>(
    `INSERT INTO template_clone_jobs
       (id, source_app_id, source_snapshot_id, source_region, dest_region,
        requested_by_user_id, dest_organization_id, dest_app_name,
        pending_env_vars, auto_mint_requests)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      id,
      args.sourceAppId,
      args.sourceSnapshotId,
      args.sourceRegion,
      args.destRegion,
      args.requestedByUserId,
      args.destOrganizationId,
      args.destAppName ?? null,
      pendingEnvVars,
      autoMintRequests,
    ],
  );
  return res.rows[0];
}

export async function getCloneJob(controlDb: pg.Pool, jobId: string): Promise<CloneJob | null> {
  const res = await controlDb.query<CloneJob>(`SELECT * FROM template_clone_jobs WHERE id = $1`, [jobId]);
  return res.rows[0] ?? null;
}

export async function setCloneJobStatus(
  controlDb: pg.Pool,
  jobId: string,
  patch: Partial<Pick<CloneJob, 'status' | 'dest_app_id' | 'error_message' | 'completed_at'>>,
): Promise<void> {
  const fields: string[] = ['updated_at = now()'];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }
  values.push(jobId);
  await controlDb.query(
    `UPDATE template_clone_jobs SET ${fields.join(', ')} WHERE id = $${i}`,
    values,
  );
}

export async function incrementRetry(controlDb: pg.Pool, jobId: string): Promise<void> {
  await controlDb.query(
    `UPDATE template_clone_jobs
     SET retry_count = retry_count + 1, status = 'pending', error_message = NULL, updated_at = now()
     WHERE id = $1`,
    [jobId],
  );
}

export async function appendCloneJobWarnings(
  controlDb: pg.Pool,
  jobId: string,
  warnings: string[],
): Promise<void> {
  if (warnings.length === 0) return;
  await controlDb.query(
    `UPDATE template_clone_jobs
     SET warnings = COALESCE(warnings, '[]'::jsonb) || $1::jsonb
     WHERE id = $2`,
    [JSON.stringify(warnings), jobId],
  );
}

/** Snapshot ids that an in-flight clone is reading from — caller adds them to planRetention's pinned set. */
export async function listActiveCloneSnapshotIdsForApp(
  controlDb: pg.Pool,
  sourceAppId: string,
): Promise<Set<string>> {
  const res = await controlDb.query<{ source_snapshot_id: string }>(
    `SELECT source_snapshot_id FROM template_clone_jobs
     WHERE source_app_id = $1 AND status IN ('pending', 'processing')`,
    [sourceAppId],
  );
  return new Set(res.rows.map(r => r.source_snapshot_id));
}
