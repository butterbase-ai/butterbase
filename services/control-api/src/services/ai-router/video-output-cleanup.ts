import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import * as outputs from './video-preparation-outputs.js';
import { createRetainedVideoStore } from './video-output-store.js';
import { retainedVideoIdentity } from './video-output-materializer.js';

/** Independent of provider IO and credentials, bounded to two cleanup claims. */
export async function maintainPreparedOutputCleanup(pool: pg.Pool, options: {
  canWork(appId: string, organizationId: string): Promise<boolean>;
  remove?: (row: outputs.PreparedOutputRow, signal: AbortSignal) => Promise<boolean>;
}): Promise<void> {
  if (!(await pool.query("SELECT to_regclass('ai_video_preparation_outputs') AS name")).rows[0]?.name) return;
  // SQL-only retirement preserves cleanup evidence when no attempt worker can
  // retain authority (deadline, deleted/failed parent, or missing app).
  const stale = (await pool.query<outputs.PreparedOutputRow>(`SELECT o.* FROM ai_video_preparation_outputs o
    JOIN ai_video_preparations p ON p.id=o.preparation_id LEFT JOIN apps a ON a.id=o.app_id
    WHERE o.archived_after_move IS NULL AND o.state IN ('pending','copying','copied','stored')
      AND (p.deleted_at IS NOT NULL OR p.status IN ('failed','cancelled','expired') OR
        (p.status<>'completed' AND p.deadline<=now()) OR a.id IS NULL)
    ORDER BY o.next_action_at LIMIT 8`)).rows;
  for (const row of stale) {
    if (!await options.canWork(row.app_id, row.organization_id)) continue;
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const app = (await tx.query('SELECT provisioning_status,organization_id FROM apps WHERE id=$1 FOR UPDATE NOWAIT', [row.app_id])).rows[0];
      if (app && (['migrating','migration_target_reserved'].includes(app.provisioning_status) || app.organization_id !== row.organization_id)) { await tx.query('ROLLBACK'); continue; }
      await tx.query(`UPDATE ai_video_preparation_outputs o SET state='cleanup_pending',deleted_at=COALESCE(o.deleted_at,now()),
        error_code='output_delivery_expired',capacity_reserved=o.capacity_reserved OR o.state IN ('copied','stored'),
        cleanup_not_before=GREATEST(o.cleanup_not_before,COALESCE(o.upload_uncertain_until,now())),
        uncertain_put=o.uncertain_put OR o.upload_uncertain_until IS NOT NULL,
        fence=o.fence+1,lease_owner=NULL,lease_expires_at=NULL,next_action_at=now(),updated_at=now()
        FROM ai_video_preparations p WHERE o.id=$1 AND p.id=o.preparation_id AND o.archived_after_move IS NULL
          AND o.state IN ('pending','copying','copied','stored') AND (p.deleted_at IS NOT NULL OR p.status IN ('failed','cancelled','expired')
            OR (p.status<>'completed' AND p.deadline<=now()) OR NOT EXISTS(SELECT 1 FROM apps WHERE id=o.app_id))`, [row.id]);
      await tx.query(`DELETE FROM storage_objects s USING ai_video_preparation_outputs o WHERE o.id=$1 AND s.id=o.object_id
        AND s.app_id=o.app_id AND s.organization_id::text=o.organization_id AND s.access_scope='prepared_video'
        AND s.published_at IS NULL AND o.state='cleanup_pending'`, [row.id]);
      await tx.query('COMMIT');
    } catch (error) { await tx.query('ROLLBACK'); if ((error as { code?: string }).code !== '55P03') throw error; }
    finally { tx.release(); }
  }
  const due = (await pool.query<outputs.PreparedOutputRow>(`SELECT * FROM ai_video_preparation_outputs WHERE archived_after_move IS NULL
    AND deleted_at IS NOT NULL AND (state='cleanup_pending' OR (state='deleted' AND cleanup_probe_until>now()))
    AND next_action_at<=now() AND cleanup_not_before<=now() AND (lease_expires_at IS NULL OR lease_expires_at<=now())
    ORDER BY next_action_at LIMIT 8`)).rows;
  for (let start=0; start<due.length; start+=2) await Promise.all(due.slice(start,start+2).map(async base => {
    if (!await options.canWork(base.app_id, base.organization_id)) return;
    const row = await outputs.claimPreparedOutputCleanup(pool, base.id, { worker: randomUUID(), leaseMs: 35_000 }); if (!row) return;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30_000); timer.unref();
    let success = false;
    try {
      const shared = await pool.query('SELECT 1 FROM storage_objects WHERE bucket=$1 AND key=$2 AND id<>$3 LIMIT 1', [row.bucket,row.object_key,row.object_id]);
      if (shared.rows.length) return;
      if (row.upload_claim_fence === null) success = true; // No PUT was ever authorized.
      else {
        controller.signal.throwIfAborted();
        const remove = options.remove ?? (async (value: outputs.PreparedOutputRow, signal: AbortSignal) => createRetainedVideoStore({ signal }).remove(retainedVideoIdentity(value)));
        await remove(row, controller.signal); success = true; // Already absent is success too.
      }
    } catch { /* Known ownership conflicts and transient IO remain durable for inspection/retry. */ }
    finally {
      clearTimeout(timer);controller.abort();
      await outputs.finishPreparedOutputCleanup(pool,row.id,row.fence,success,new Date(Date.now()+60_000));
    }
  }));
}
