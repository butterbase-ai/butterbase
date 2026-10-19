import type pg from 'pg';
import type { PreparationDb } from './video-preparations.js';
import { ensureReferenceAsset, getReferenceAsset, claimReferenceAsset, type AssetScope, type ReferenceAssetRow, type ReferenceCleanupRow } from './reference-assets.js';
const table = (kind: 'asset'|'group') => kind === 'asset' ? 'ai_reference_assets' : 'ai_reference_asset_groups';
const values = (s: AssetScope) => [s.organizationId,s.appId,s.endUserSub,s.providerSlot,s.credentialNamespace];
const scopeSql = 'organization_id=$1 AND app_id=$2 AND end_user_sub IS NOT DISTINCT FROM $3::text AND provider_slot=$4 AND credential_namespace=$5';
export async function referenceTransaction<T>(db: PreparationDb, run: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
 if ('release' in db) return run(db as pg.PoolClient);
 const tx = await (db as pg.Pool).connect();
 try { await tx.query('BEGIN'); const value = await run(tx); await tx.query('COMMIT'); return value; }
 catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
export async function lockReferenceScope(db: PreparationDb, scope: AssetScope): Promise<void> {
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(values(scope))]);
}
/** A reference includes pre-upload hashes, because a crash may precede saving a
 * local referenceId. Pending paid receipts retain dependencies after deletion. */
export const retainedAssetSql = (asset = 'r') => `EXISTS (SELECT 1 FROM ai_video_preparations p WHERE p.archived_after_move IS NULL
 AND p.organization_id=${asset}.organization_id AND p.app_id=${asset}.app_id AND p.end_user_sub IS NOT DISTINCT FROM ${asset}.end_user_sub
 AND p.request_json->'selection'->>'providerSlot'=${asset}.provider_slot AND p.request_json->'selection'->>'credentialNamespace'=${asset}.credential_namespace
 AND (p.status IN ('pending','in_progress') OR (p.deleted_at IS NULL AND p.input_expires_at>now()) OR EXISTS(SELECT 1 FROM ai_video_attempts t WHERE t.preparation_id=p.id AND t.archived_after_move IS NULL AND t.settlement_status!='acknowledged'))
 AND (EXISTS(SELECT 1 FROM jsonb_each(p.reference_progress) v WHERE v.value->>'referenceId'=${asset}.id::text OR v.value->>'sha256'=${asset}.sha256)
 OR EXISTS(SELECT 1 FROM jsonb_each(COALESCE(p.input_identity,'{}'::jsonb)) v WHERE v.value->>'sha256'=${asset}.sha256)))`;
export async function retireReferenceAsset(db: PreparationDb, scope: AssetScope, id: string): Promise<boolean> {
 return (await db.query(`UPDATE ai_reference_assets SET retired_at=CASE WHEN status IN ('registering','uncertain') THEN retired_at ELSE COALESCE(retired_at,now()) END,deleted_at=COALESCE(deleted_at,now()),cleanup_pending=true,updated_at=now() WHERE ${scopeSql} AND id=$6 AND archived_after_move IS NULL`,[...values(scope),id])).rowCount===1;
}
/** A new operation identity is legal only with definitive provider evidence.
 * At most one replacement per lineage; old rows are never reset/reuploaded. */
export async function replaceUnavailableReference(db: PreparationDb, scope: AssetScope, id: string, limits?: ReferenceLimits): Promise<ReferenceAssetRow|null> {
 return referenceTransaction(db,async tx=>{
  await lockReferenceScope(tx,scope);
  const old=await getReferenceAsset(tx,scope,id);
  if (!old || old.replacement_count>=1 || old.status!=='failed' || old.diagnostic?.code!=='asset_unavailable' || !['deleted','expired'].includes(String(old.diagnostic.reason))) return null;
  await retireReferenceAsset(tx,scope,id);
  const fresh=limits ? await ensureReferenceAssetLimited(tx,scope,old.sha256,Number(old.source_bytes),limits) : await ensureReferenceAsset(tx,scope,old.sha256);
  await tx.query('UPDATE ai_reference_assets SET replacement_count=1,source_bytes=$2 WHERE id=$1',[fresh.id,old.source_bytes]);
  return fresh;
 });
}
export async function claimReferenceCleanup(db: PreparationDb, kind:'asset'|'group', id:string, worker:string, leaseMs:number):Promise<ReferenceCleanupRow|null> {
 if (!Number.isSafeInteger(leaseMs)||leaseMs<=0) throw Error('Invalid cleanup lease');
 return (await db.query<ReferenceCleanupRow>(`UPDATE ${table(kind)} r SET fence=fence+1,lease_owner=$2,lease_expires_at=now()+$3*interval '1 millisecond',cleanup_attempts=cleanup_attempts+1
 WHERE id=$1 AND archived_after_move IS NULL AND cleanup_pending AND cleanup_next_at<=now()
 AND status NOT IN ('registering','uncertain') AND (lease_expires_at IS NULL OR lease_expires_at<=now())
 ${kind==='asset'?`AND NOT ${retainedAssetSql()}`:`AND NOT EXISTS(SELECT 1 FROM ai_reference_assets a WHERE a.group_id=r.id AND a.cleaned_at IS NULL)`}
 RETURNING r.*,'${kind}'::text AS kind`,[id,worker,leaseMs])).rows[0]??null;
}
export async function finishReferenceCleanup(db:PreparationDb,row:ReferenceCleanupRow,success:boolean,retryMs=60000):Promise<boolean>{
 return (await db.query(`UPDATE ${table(row.kind)} SET cleanup_pending=NOT $3,cleaned_at=CASE WHEN $3 THEN now() ELSE cleaned_at END,
 retired_at=CASE WHEN $3 THEN COALESCE(retired_at,now()) ELSE retired_at END,status=CASE WHEN $3 THEN 'deleted' ELSE status END,lease_owner=NULL,lease_expires_at=NULL,cleanup_next_at=now()+$4*interval '1 millisecond',updated_at=now()
 WHERE id=$1 AND fence=$2 AND cleanup_pending AND archived_after_move IS NULL`,[row.id,row.fence,success,Math.max(1000,Math.min(retryMs,3600000))])).rowCount===1;
}
/** One-way source erasure at 24h is independent of receipt resolution. Durable
 * hashes, local/provider handles, frozen selection and all money evidence stay. */
export async function sweepReferenceRetention(db:PreparationDb,limit=100):Promise<void>{
 const bound=Math.max(1,Math.min(limit,100));
 await db.query(`UPDATE ai_video_preparations SET request_json=video_preparation_redacted_request(request_json),source_erased_at=now(),updated_at=now()
 WHERE id IN (SELECT id FROM ai_video_preparations WHERE archived_after_move IS NULL AND source_erased_at IS NULL AND input_expires_at<=now() AND deadline<=now() ORDER BY input_expires_at LIMIT $1)`,[bound]);
 await db.query(`UPDATE ai_reference_assets r SET retired_at=COALESCE(retired_at,now()),deleted_at=COALESCE(deleted_at,now()),cleanup_pending=true,updated_at=now()
 WHERE id IN (SELECT r.id FROM ai_reference_assets r WHERE archived_after_move IS NULL AND cleaned_at IS NULL AND NOT cleanup_pending AND status NOT IN ('registering','uncertain') AND created_at<=now()-interval '24 hours' AND NOT ${retainedAssetSql()} ORDER BY created_at LIMIT $1)`,[bound]);
 await db.query(`UPDATE ai_reference_asset_groups g SET retired_at=COALESCE(retired_at,now()),deleted_at=COALESCE(deleted_at,now()),cleanup_pending=true,updated_at=now()
 WHERE id IN (SELECT g.id FROM ai_reference_asset_groups g WHERE archived_after_move IS NULL AND cleaned_at IS NULL AND NOT cleanup_pending AND status NOT IN ('registering','uncertain') AND created_at<=now()-interval '24 hours'
 AND NOT EXISTS(SELECT 1 FROM ai_reference_assets a WHERE a.group_id=g.id AND a.retired_at IS NULL AND a.deleted_at IS NULL) ORDER BY created_at LIMIT $1)`,[bound]);
}
export interface ReferenceLimits { retainedAssets:number; retainedBytes:number; registrationsPerHour:number; concurrency:number }
export class ReferenceLimitError extends Error { readonly code='REFERENCE_CAPACITY_EXCEEDED'; constructor(){super('Reference capacity exceeded');} }
/** Private policy supplies bounds; transaction scope serializes count+admit. */
export async function ensureReferenceAssetLimited(db:PreparationDb,scope:AssetScope,sha256:string,bytes:number,limits:ReferenceLimits):Promise<ReferenceAssetRow>{
 return referenceTransaction(db,async tx=>{
  await lockReferenceScope(tx,scope);
  const found=(await tx.query<ReferenceAssetRow>(`SELECT * FROM ai_reference_assets WHERE ${scopeSql} AND sha256=$6 AND retired_at IS NULL`,[...values(scope),sha256])).rows[0];
  if(found) return ensureReferenceAsset(tx,scope,sha256);
  const stats=(await tx.query<{assets:string;bytes:string;recent:string}>(`SELECT count(*) FILTER(WHERE cleaned_at IS NULL)::text AS assets,COALESCE(sum(source_bytes) FILTER(WHERE cleaned_at IS NULL),0)::text AS bytes,count(*) FILTER(WHERE created_at>now()-interval '1 hour')::text AS recent FROM ai_reference_assets WHERE ${scopeSql} AND archived_after_move IS NULL`,values(scope))).rows[0];
  if(Number(stats.assets)>=limits.retainedAssets||Number(stats.bytes)+bytes>limits.retainedBytes||Number(stats.recent)>=limits.registrationsPerHour) throw new ReferenceLimitError();
  const row=await ensureReferenceAsset(tx,scope,sha256);await tx.query('UPDATE ai_reference_assets SET source_bytes=$2 WHERE id=$1',[row.id,bytes]);return row;
 });
}

export async function claimReferenceAssetLimited(db:PreparationDb,scope:AssetScope,id:string,worker:string,leaseMs:number,limits:ReferenceLimits):Promise<ReferenceAssetRow|null>{
 return referenceTransaction(db,async tx=>{
  await lockReferenceScope(tx,scope);
  const count=await tx.query<{count:string}>(`SELECT count(*) FROM ai_reference_assets WHERE ${scopeSql} AND archived_after_move IS NULL AND cleaned_at IS NULL AND lease_expires_at>now()`,values(scope));
  if(Number(count.rows[0].count)>=limits.concurrency) return null;
  return claimReferenceAsset(tx,scope,id,worker,leaseMs);
 });
}

/** Ready page excludes held references before LIMIT so one uncertain/active
 * dependency cannot starve other tombstones. Groups wait for all child acks. */
export async function listReadyReferenceCleanup(db:PreparationDb,limit=8):Promise<ReferenceCleanupRow[]> {
 const columns='id,organization_id,app_id,end_user_sub,provider_slot,credential_namespace,provider_id,status,cleanup_pending,deleted_at,cleaned_at,fence,lease_owner,lease_expires_at,cleanup_next_at';
 const due="archived_after_move IS NULL AND cleanup_pending AND cleanup_next_at<=now() AND status NOT IN ('registering','uncertain') AND (lease_expires_at IS NULL OR lease_expires_at<=now())";
 return (await db.query<ReferenceCleanupRow>(`SELECT ${columns},'asset'::text AS kind FROM ai_reference_assets r WHERE ${due} AND NOT ${retainedAssetSql()}
 UNION ALL SELECT ${columns},'group'::text AS kind FROM ai_reference_asset_groups r WHERE ${due} AND NOT EXISTS(SELECT 1 FROM ai_reference_assets a WHERE a.group_id=r.id AND a.cleaned_at IS NULL)
 ORDER BY cleanup_next_at,kind,id LIMIT $1`,[Math.max(1,Math.min(limit,100))])).rows;
}
