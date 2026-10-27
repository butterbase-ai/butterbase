import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { finishPreparation, storedVideoOutputIds, type AttemptRow, type PreparationRow, type TerminalOutcome } from './video-preparations.js';

export const PREPARED_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;
export const PREPARED_OUTPUT_COPY_CAPACITY = 2;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PreparedOutputRow {
  id: string;
  preparation_id: string;
  attempt_id: string;
  organization_id: string;
  app_id: string;
  user_id: string;
  end_user_sub: string | null;
  output_index: number;
  expected_outputs: number;
  object_id: string;
  bucket: string;
  object_key: string;
  state: 'pending' | 'copying' | 'copied' | 'stored' | 'cleanup_pending' | 'deleted' | 'failed';
  provider_cost_usd: string | null;
  provider_completed_at: Date;
  size_bytes: string | null;
  sha256: string | null;
  content_type: 'video/mp4' | 'video/webm' | null;
  capacity_reserved: boolean;
  upload_claim_fence: number | null;
  upload_uncertain_until: Date | null;
  uncertain_put: boolean;
  deadline: Date;
  next_action_at: Date;
  attempts: number;
  error_code: string | null;
  deleted_at: Date | null;
  cleanup_not_before: Date;
  cleanup_probe_until: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  claim_attempt_fence: number | null;
  fence: number;
  archived_after_move: string | null;
}

export class PreparedOutputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PreparedOutputError';
  }
}

interface Authority { attempt: AttemptRow; job: PreparationRow }

/** Short SQL-only transactions, with the app locked before its retained children. */
async function withAuthority<T>(pool: pg.Pool, attemptId: string, fence: number,
  operation: (tx: pg.PoolClient, scope: Authority) => Promise<T>, nowait = false): Promise<T | null> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const base = (await tx.query<AttemptRow>('SELECT * FROM ai_video_attempts WHERE id=$1 AND archived_after_move IS NULL', [attemptId])).rows[0];
    if (!base) { await tx.query('ROLLBACK'); return null; }
    const app = (await tx.query(`SELECT id,owner_id,organization_id,provisioning_status FROM apps WHERE id=$1 FOR UPDATE${nowait ? ' NOWAIT' : ''}`, [base.app_id])).rows[0];
    const job = (await tx.query<PreparationRow>('SELECT * FROM ai_video_preparations WHERE id=$1 AND archived_after_move IS NULL FOR UPDATE', [base.preparation_id])).rows[0];
    const attempt = (await tx.query<AttemptRow>('SELECT * FROM ai_video_attempts WHERE id=$1 AND archived_after_move IS NULL FOR UPDATE', [attemptId])).rows[0];
    if (!app || !job || !attempt || app.provisioning_status !== 'ready'
      || app.owner_id !== job.user_id || app.organization_id !== job.organization_id
      || attempt.organization_id !== job.organization_id || attempt.app_id !== job.app_id
      || job.deleted_at || !['pending', 'in_progress'].includes(job.status) || job.deadline <= new Date()
      || attempt.submission_state !== 'accepted' || attempt.fence !== fence
      || !attempt.lease_expires_at || attempt.lease_expires_at <= new Date()) {
      await tx.query('ROLLBACK'); return null;
    }
    const result = await operation(tx, { attempt, job });
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK');
    if (nowait && (error as { code?: string }).code === '55P03') return null;
    throw error;
  } finally { tx.release(); }
}

export async function listPreparedOutputs(db: pg.Pool | pg.PoolClient, attemptId: string): Promise<PreparedOutputRow[]> {
  return (await db.query<PreparedOutputRow>(`SELECT * FROM ai_video_preparation_outputs
    WHERE attempt_id=$1 AND archived_after_move IS NULL ORDER BY output_index`, [attemptId])).rows;
}

export async function ensurePreparedOutputs(pool: pg.Pool, args: {
  attemptId: string; attemptFence: number; bucket: string; count: number; providerCostUsd?: number;
}): Promise<PreparedOutputRow[] | null> {
  if (!Number.isSafeInteger(args.count) || args.count < 1 || args.count > 8) throw new PreparedOutputError('OUTPUT_INVALID_COUNT', 'Invalid output count');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(args.bucket)) throw new PreparedOutputError('OUTPUT_INVALID_BUCKET', 'Invalid output bucket');
  if (args.providerCostUsd !== undefined && (!Number.isFinite(args.providerCostUsd) || args.providerCostUsd < 0 || args.providerCostUsd >= 1_000_000)) throw new PreparedOutputError('OUTPUT_INVALID_COST', 'Invalid output cost evidence');
  return withAuthority(pool, args.attemptId, args.attemptFence, async (tx, { attempt, job }) => {
    if (!uuid.test(job.user_id) || !/^[a-zA-Z0-9_-]+$/.test(job.app_id)) throw new PreparedOutputError('OUTPUT_INVALID_SCOPE', 'Invalid output key namespace');
    let rows = await listPreparedOutputs(tx, attempt.id);
    if (rows.length && (rows.length !== args.count || rows.some(r => r.expected_outputs !== args.count || r.bucket !== args.bucket))) throw new PreparedOutputError('OUTPUT_IDENTITY_CHANGED', 'Output count or storage identity changed');
    if (!rows.length) {
      for (let index = 0; index < args.count; index++) {
        const objectId = randomUUID();
        await tx.query(`INSERT INTO ai_video_preparation_outputs
          (preparation_id,attempt_id,organization_id,app_id,user_id,end_user_sub,output_index,expected_outputs,object_id,bucket,object_key,deadline,provider_cost_usd)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [job.id, attempt.id, job.organization_id, job.app_id, job.user_id, job.end_user_sub, index, args.count, objectId, args.bucket,
          `${job.app_id}/${job.user_id}/${objectId}_generated-video-${index}`, job.deadline, args.providerCostUsd ?? null]);
      }
    } else if (args.providerCostUsd !== undefined && rows.every(r => r.provider_cost_usd === null)) {
      await tx.query('UPDATE ai_video_preparation_outputs SET provider_cost_usd=$2 WHERE attempt_id=$1 AND archived_after_move IS NULL', [attempt.id, args.providerCostUsd]);
    }
    rows = await listPreparedOutputs(tx, attempt.id);
    return rows;
  });
}

export async function claimPreparedOutput(pool: pg.Pool, id: string, args: {
  attemptFence: number; worker: string; leaseMs?: number; capacity?: number;
}): Promise<PreparedOutputRow | null> {
  const leaseMs = args.leaseMs ?? 30_000, capacity = args.capacity ?? PREPARED_OUTPUT_COPY_CAPACITY;
  if (!args.worker || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 60_000
    || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 8) throw new PreparedOutputError('OUTPUT_INVALID_CLAIM', 'Invalid output claim');
  const base = (await pool.query<PreparedOutputRow>('SELECT * FROM ai_video_preparation_outputs WHERE id=$1 AND archived_after_move IS NULL', [id])).rows[0];
  if (!base) return null;
  return withAuthority(pool, base.attempt_id, args.attemptFence, async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('prepared-video-output-copy-capacity',0))");
    const active = (await tx.query<{ count: string }>(`SELECT count(*) FROM ai_video_preparation_outputs
      WHERE archived_after_move IS NULL AND state='copying' AND lease_expires_at>now()`)).rows[0];
    if (Number(active.count) >= capacity) return null;
    return (await tx.query<PreparedOutputRow>(`UPDATE ai_video_preparation_outputs SET state='copying',
      fence=fence+1,lease_owner=$2,lease_expires_at=LEAST(deadline,now()+$3*interval '1 millisecond'),
      claim_attempt_fence=$4,attempts=attempts+1,uncertain_put=uncertain_put OR upload_uncertain_until IS NOT NULL,updated_at=now()
      WHERE id=$1 AND state IN ('pending','copying') AND deleted_at IS NULL AND archived_after_move IS NULL
        AND deadline>now() AND next_action_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<=now()) RETURNING *`,
    [id, args.worker, leaseMs, args.attemptFence])).rows[0] ?? null;
  }, true);
}

const liveCopy = `v.id=$1 AND v.fence=$2 AND v.state='copying' AND v.lease_expires_at>now()
  AND v.archived_after_move IS NULL AND v.deleted_at IS NULL AND v.deadline>now()
  AND EXISTS(SELECT 1 FROM ai_video_attempts a JOIN ai_video_preparations p ON p.id=a.preparation_id
    JOIN apps app ON app.id=p.app_id WHERE a.id=v.attempt_id AND a.fence=v.claim_attempt_fence
    AND a.submission_state='accepted' AND a.lease_expires_at>now() AND a.archived_after_move IS NULL
    AND p.deleted_at IS NULL AND p.archived_after_move IS NULL AND p.deadline>now()
    AND app.provisioning_status='ready' AND app.organization_id::text=v.organization_id AND app.owner_id::text=v.user_id)`;

export async function recordPreparedOutputMeasurement(pool: pg.Pool, id: string, fence: number, value: {
  sizeBytes: number; sha256: string; contentType: string;
}): Promise<boolean> {
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > PREPARED_OUTPUT_MAX_BYTES
    || !/^[a-f0-9]{64}$/.test(value.sha256) || !['video/mp4', 'video/webm'].includes(value.contentType)) throw new PreparedOutputError('OUTPUT_INVALID_MEDIA', 'Invalid output media measurement');
  const result = await pool.query(`UPDATE ai_video_preparation_outputs v SET size_bytes=$3,sha256=$4,content_type=$5,updated_at=now()
    WHERE ${liveCopy}`, [id, fence, value.sizeBytes, value.sha256, value.contentType]);
  return result.rowCount === 1;
}

export async function markPreparedOutputCopied(pool: pg.Pool, id: string, fence: number): Promise<boolean> {
  const result = await pool.query(`UPDATE ai_video_preparation_outputs v SET state='copied',lease_owner=NULL,lease_expires_at=NULL,
    upload_uncertain_until=CASE WHEN uncertain_put THEN upload_uncertain_until ELSE NULL END,
    cleanup_probe_until=CASE WHEN uncertain_put THEN cleanup_probe_until ELSE NULL END,updated_at=now()
    WHERE ${liveCopy} AND v.capacity_reserved AND v.sha256 IS NOT NULL`, [id, fence]);
  return result.rowCount === 1;
}

/** This durable marker must commit before a PUT can leave the process. */
export async function markPreparedOutputUploadStarted(pool: pg.Pool, id: string, fence: number): Promise<boolean> {
  return (await pool.query(`UPDATE ai_video_preparation_outputs v SET upload_claim_fence=$2,
    upload_uncertain_until=GREATEST(upload_uncertain_until,now()+interval '2 minutes'),
    cleanup_probe_until=GREATEST(cleanup_probe_until,now()+interval '1 day'),updated_at=now()
    WHERE ${liveCopy} AND capacity_reserved AND sha256 IS NOT NULL AND upload_claim_fence IS DISTINCT FROM $2`, [id, fence])).rowCount === 1;
}

export async function deferPreparedOutput(pool: pg.Pool, id: string, fence: number, errorCode: string, next: Date): Promise<boolean> {
  if (!Number.isFinite(next.getTime()) || !/^[a-z_]{1,80}$/.test(errorCode)) throw new PreparedOutputError('OUTPUT_INVALID_RETRY', 'Invalid output retry');
  return (await pool.query(`UPDATE ai_video_preparation_outputs v SET state='pending',lease_owner=NULL,lease_expires_at=NULL,
    uncertain_put=uncertain_put OR upload_uncertain_until IS NOT NULL,error_code=$3,next_action_at=$4,updated_at=now()
    WHERE ${liveCopy}`, [id, fence, errorCode, next])).rowCount === 1;
}

export async function requestPreparedOutputCleanup(pool: pg.Pool, args: {
  attemptId: string; attemptFence: number; errorCode: string;
}): Promise<boolean> {
  if (!/^[a-z_]{1,80}$/.test(args.errorCode)) throw new PreparedOutputError('OUTPUT_INVALID_FAILURE', 'Invalid output failure');
  return await withAuthority(pool, args.attemptId, args.attemptFence, async (tx, { attempt, job }) => {
    const rows = await listPreparedOutputs(tx, attempt.id);
    await tx.query(`UPDATE ai_video_preparation_outputs SET state='cleanup_pending',deleted_at=COALESCE(deleted_at,now()),
      error_code=$2,capacity_reserved=capacity_reserved OR state IN ('copied','stored'),
      cleanup_not_before=GREATEST(cleanup_not_before,COALESCE(upload_uncertain_until,now())),
      uncertain_put=uncertain_put OR upload_uncertain_until IS NOT NULL,
      fence=fence+1,lease_owner=NULL,lease_expires_at=NULL,next_action_at=now(),updated_at=now()
      WHERE attempt_id=$1 AND archived_after_move IS NULL AND state NOT IN ('cleanup_pending','deleted')`, [attempt.id, args.errorCode]);
    await tx.query("DELETE FROM storage_objects WHERE id=ANY($1::uuid[]) AND app_id=$2 AND organization_id=$3 AND access_scope='prepared_video' AND published_at IS NULL", [rows.map(row => row.object_id), job.app_id, job.organization_id]);
    return true;
  }) ?? false;
}

export async function claimPreparedOutputCleanup(pool: pg.Pool, id: string, args: {
  worker: string; leaseMs?: number;
}): Promise<PreparedOutputRow | null> {
  const leaseMs = args.leaseMs ?? 30_000;
  if (!args.worker || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 60_000) throw new PreparedOutputError('OUTPUT_INVALID_CLAIM', 'Invalid output cleanup claim');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const base = (await tx.query<PreparedOutputRow>('SELECT * FROM ai_video_preparation_outputs WHERE id=$1 AND archived_after_move IS NULL', [id])).rows[0];
    if (!base) { await tx.query('ROLLBACK'); return null; }
    const app = (await tx.query('SELECT organization_id,provisioning_status FROM apps WHERE id=$1 FOR UPDATE NOWAIT', [base.app_id])).rows[0];
    if (app && (app.organization_id !== base.organization_id || ['migrating', 'migration_target_reserved'].includes(app.provisioning_status))) { await tx.query('ROLLBACK'); return null; }
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('prepared-video-output-cleanup-capacity',0))");
    const active = (await tx.query<{ count: string }>(`SELECT count(*) FROM ai_video_preparation_outputs WHERE archived_after_move IS NULL
      AND state IN ('cleanup_pending','deleted') AND lease_owner IS NOT NULL AND lease_expires_at>now()`)).rows[0];
    if (Number(active.count) >= 2) { await tx.query('ROLLBACK'); return null; }
    const row = (await tx.query<PreparedOutputRow>(`UPDATE ai_video_preparation_outputs SET fence=fence+1,lease_owner=$2,
      lease_expires_at=now()+$3*interval '1 millisecond',attempts=attempts+1,updated_at=now()
      WHERE id=$1 AND archived_after_move IS NULL AND deleted_at IS NOT NULL AND (state='cleanup_pending' OR (state='deleted' AND cleanup_probe_until>now()))
        AND cleanup_not_before<=now() AND next_action_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<=now()) RETURNING *`, [id, args.worker, leaseMs])).rows[0] ?? null;
    await tx.query('COMMIT'); return row;
  } catch (error) {
    await tx.query('ROLLBACK'); if ((error as { code?: string }).code === '55P03') return null; throw error;
  } finally { tx.release(); }
}

export async function finishPreparedOutputCleanup(pool: pg.Pool, id: string, fence: number, success: boolean, next: Date): Promise<boolean> {
  if (!Number.isFinite(next.getTime())) throw new PreparedOutputError('OUTPUT_INVALID_RETRY', 'Invalid cleanup retry');
  return (await pool.query(`UPDATE ai_video_preparation_outputs SET state=CASE WHEN $3 THEN 'deleted' ELSE 'cleanup_pending' END,
    capacity_reserved=CASE WHEN $3 THEN false ELSE capacity_reserved END,deleted_at=COALESCE(deleted_at,now()),
    lease_owner=NULL,lease_expires_at=NULL,next_action_at=$4,updated_at=now()
    WHERE id=$1 AND fence=$2 AND lease_expires_at>now() AND archived_after_move IS NULL AND state IN ('cleanup_pending','deleted')`,
  [id, fence, success, next])).rowCount === 1;
}

/** A late successful write may rearm a tombstone, never retire another live worker's output. */
export async function rearmLatePreparedOutputCleanup(pool: pg.Pool, id: string): Promise<boolean> {
  return (await pool.query(`UPDATE ai_video_preparation_outputs SET state='cleanup_pending',
    capacity_reserved=(size_bytes IS NOT NULL),next_action_at=now(),updated_at=now()
    WHERE id=$1 AND archived_after_move IS NULL AND deleted_at IS NOT NULL AND state IN ('cleanup_pending','deleted')`, [id])).rowCount === 1;
}

export async function commitPreparedOutputMetadata(pool: pg.Pool, args: {
  attemptId: string; attemptFence: number;
}): Promise<string[] | null> {
  return withAuthority(pool, args.attemptId, args.attemptFence, async (tx, { attempt, job }) => {
    const rows = (await tx.query<PreparedOutputRow>(`SELECT * FROM ai_video_preparation_outputs
      WHERE attempt_id=$1 AND archived_after_move IS NULL ORDER BY output_index FOR UPDATE`, [attempt.id])).rows;
    if (!rows.length || rows.length !== rows[0].expected_outputs
      || rows.some((r, index) => r.output_index !== index || r.deleted_at || !['copied', 'stored'].includes(r.state))) return null;
    for (const row of rows) {
      const filename = `generated-video-${row.output_index}.${row.content_type === 'video/webm' ? 'webm' : 'mp4'}`;
      await tx.query(`INSERT INTO storage_objects(id,app_id,organization_id,user_id,bucket,key,filename,content_type,size_bytes,public,metadata,access_scope,access_subject,published_at)
        VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8,false,$9,'prepared_video',$10,NULL) ON CONFLICT(id) DO NOTHING`,
      [row.object_id, job.app_id, job.organization_id, row.bucket, row.object_key, filename, row.content_type, row.size_bytes,
        { sha256: row.sha256, videoPreparationId: job.id, videoAttemptId: attempt.id }, job.end_user_sub]);
      const object = (await tx.query('SELECT * FROM storage_objects WHERE id=$1 FOR UPDATE', [row.object_id])).rows[0];
      if (!object || object.app_id !== job.app_id || object.organization_id !== job.organization_id || object.bucket !== row.bucket
        || object.key !== row.object_key || Number(object.size_bytes) !== Number(row.size_bytes) || object.content_type !== row.content_type
        || object.access_scope !== 'prepared_video' || object.access_subject !== job.end_user_sub || object.public
        || object.published_at || object.archived_after_move || object.metadata?.sha256 !== row.sha256) throw new PreparedOutputError('OUTPUT_IDENTITY_CHANGED', 'Foreign output metadata or storage identity changed');
    }
    await tx.query(`UPDATE ai_video_preparation_outputs SET state='stored',capacity_reserved=false,updated_at=now()
      WHERE attempt_id=$1 AND state='copied' AND archived_after_move IS NULL`, [attempt.id]);
    return rows.map(row => row.object_id);
  });
}

/** Retained bytes become customer-visible only with the final acknowledged receipt. */
export async function finishStoredPreparation(pool: pg.Pool, jobId: string, jobFence: number): Promise<boolean> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const base = (await tx.query<PreparationRow>('SELECT * FROM ai_video_preparations WHERE id=$1 AND archived_after_move IS NULL', [jobId])).rows[0];
    if (!base) { await tx.query('ROLLBACK'); return false; }
    const app = (await tx.query('SELECT owner_id,organization_id,provisioning_status FROM apps WHERE id=$1 FOR UPDATE', [base.app_id])).rows[0];
    const job = (await tx.query<PreparationRow>('SELECT * FROM ai_video_preparations WHERE id=$1 AND archived_after_move IS NULL FOR UPDATE', [jobId])).rows[0];
    if (!app || !job || app.provisioning_status !== 'ready' || app.owner_id !== job.user_id || app.organization_id !== job.organization_id
      || job.fence !== jobFence || job.deleted_at || !['pending', 'in_progress'].includes(job.status)
      || !job.lease_expires_at || job.lease_expires_at <= new Date()) { await tx.query('ROLLBACK'); return false; }
    const attempts = (await tx.query<AttemptRow>('SELECT * FROM ai_video_attempts WHERE preparation_id=$1 AND archived_after_move IS NULL ORDER BY attempt_number FOR UPDATE', [job.id])).rows;
    const last = attempts.at(-1), ids = storedVideoOutputIds(last?.terminal_outcome ?? null);
    if (!last || !ids || attempts.some(a => a.settlement_status !== 'acknowledged')) { await tx.query('ROLLBACK'); return false; }
    if (attempts.some(a => typeof a.settlement_receipt?.chargedUsd !== 'number' || !Number.isFinite(a.settlement_receipt.chargedUsd) || a.settlement_receipt.chargedUsd < 0)) throw new PreparedOutputError('OUTPUT_INVALID_RECEIPT', 'Invalid output settlement receipt');
    let outcome: TerminalOutcome = last.terminal_outcome!;
    const rows = (await tx.query<PreparedOutputRow>(`SELECT * FROM ai_video_preparation_outputs
      WHERE attempt_id=$1 AND archived_after_move IS NULL ORDER BY output_index FOR UPDATE`, [last.id])).rows;
    if (last.settlement_receipt?.status !== 'settled') {
      outcome = { status: 'failed', error: 'reservation_unavailable', providerStatus: 'completed',
        ...(typeof outcome.providerCostUsd === 'number' ? { providerCostUsd: outcome.providerCostUsd } : {}) };
      await tx.query(`UPDATE ai_video_preparation_outputs SET state='cleanup_pending',deleted_at=COALESCE(deleted_at,now()),
        error_code='reservation_unavailable',capacity_reserved=(size_bytes IS NOT NULL),fence=fence+1,
        lease_owner=NULL,lease_expires_at=NULL,next_action_at=now(),updated_at=now()
        WHERE attempt_id=$1 AND archived_after_move IS NULL AND state NOT IN ('cleanup_pending','deleted')`, [last.id]);
      await tx.query("DELETE FROM storage_objects WHERE id=ANY($1::uuid[]) AND app_id=$2 AND organization_id=$3 AND access_scope='prepared_video'", [ids, job.app_id, job.organization_id]);
    } else {
      if (rows.length !== ids.length || rows.some((row, index) => row.object_id !== ids[index] || row.output_index !== index
        || row.state !== 'stored' || row.deleted_at || row.app_id !== job.app_id || row.organization_id !== job.organization_id)) throw new PreparedOutputError('OUTPUT_METADATA_UNAVAILABLE', 'Retained output metadata unavailable');
      for (const row of rows) {
        const object = (await tx.query('SELECT * FROM storage_objects WHERE id=$1 FOR UPDATE', [row.object_id])).rows[0];
        if (!object || object.app_id !== job.app_id || object.organization_id !== job.organization_id || object.key !== row.object_key
          || object.bucket !== row.bucket || object.access_scope !== 'prepared_video' || object.access_subject !== job.end_user_sub
          || object.public || object.archived_after_move || Number(object.size_bytes) !== Number(row.size_bytes)
          || object.content_type !== row.content_type || object.metadata?.sha256 !== row.sha256) throw new PreparedOutputError('OUTPUT_METADATA_UNAVAILABLE', 'Retained output metadata unavailable');
      }
    }
    if (!await finishPreparation(tx, job.id, jobFence, outcome)) { await tx.query('ROLLBACK'); return false; }
    if (outcome.status === 'completed') await tx.query('UPDATE storage_objects SET published_at=COALESCE(published_at,now()) WHERE id=ANY($1::uuid[]) AND app_id=$2', [ids, job.app_id]);
    await tx.query('COMMIT');
    return true;
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
