import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import * as a from './reference-assets.js';
import * as p from './video-preparations.js';
import * as l from './reference-lifecycle.js';
const url=process.env.PORTRAIT_TEST_DATABASE_URL,schema=`portrait_lifecycle_${randomUUID().replaceAll('-','')}`;
let db:pg.Pool;
const scope={organizationId:'org',appId:'app',endUserSub:null,providerSlot:'test',credentialNamespace:'key'};
const request={request:{model:'test',duration:5,input_images:['https://private.invalid/secret'],prompt:'private'},selection:{providerSlot:'test',credentialNamespace:'key',billingContext:{frozen:1}}};
async function job(expired=false){return p.createPreparation(db,{...scope,userId:'owner',model:'test',requestJson:request,deadline:new Date(Date.now()+(expired?-2000:60000)),inputExpiresAt:new Date(Date.now()+(expired?-1000:86400000))});}
async function active(){const row=await a.ensureReferenceAsset(db,scope,'a'.repeat(64));const c=(await a.claimReferenceAsset(db,scope,row.id,'one',1000))!;await a.persistReferenceAsset(db,scope,row.id,c.fence,{status:'active',providerId:'ta_old'});await db.query("UPDATE ai_reference_assets SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[row.id]);return row;}
describe.skipIf(!url)('reference lifecycle real PostgreSQL',()=>{
 beforeAll(async()=>{const u=new URL(url!);if(u.hostname!=='127.0.0.1'||u.port!=='15439'||u.pathname!=='/portrait_test')throw Error('isolated database required');db=new pg.Pool({connectionString:url,options:`-c search_path=${schema},public`,max:10});await db.query(`CREATE SCHEMA ${schema}`);await db.query('CREATE TABLE apps(id text PRIMARY KEY,organization_id text,owner_id text,provisioning_status text)');for(const name of ['056_ai_video_preparations.sql','057_ai_video_preparation_schedule.sql','058_ai_reference_lifecycle.sql'])await db.query(await readFile(new URL(`../../../../../db/runtime-plane/${name}`,import.meta.url),'utf8'));});
 afterAll(async()=>{if(db){await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();}});
 beforeEach(async()=>{await db.query('TRUNCATE ai_video_attempts,ai_video_preparations,ai_reference_assets,ai_reference_asset_groups,apps CASCADE');await db.query("INSERT INTO apps VALUES('app','org','owner','ready')");});
 it('keeps active references through deletion and releases after last settlement',async()=>{const asset=await active(),j=await job();await db.query('UPDATE ai_video_preparations SET reference_progress=$2 WHERE id=$1',[j.id,{'/input_images/0':{sha256:asset.sha256,referenceId:asset.id,assetId:'ta_old'}}]);const c=(await p.claimPreparation(db,j.id,'worker',1000))!;const attempt=(await p.createAttempt(db,j.id,c.fence,{providerSlot:'test',credentialNamespace:'key',billingContext:{}}))!;await db.query("DELETE FROM apps WHERE id='app'");expect((await p.getPreparation(db,j.id))?.status).toBe('cancelled');expect((await a.getReferenceAsset(db,scope,asset.id))?.cleanup_pending).toBe(true);expect(await l.claimReferenceCleanup(db,'asset',asset.id,'cleanup',1000)).toBeNull();await p.markAttemptTerminal(db,attempt.id,attempt.fence,{status:'cancelled'});await p.acknowledgeAttemptSettlement(db,attempt.id,{receipt:'kept'});expect(await l.claimReferenceCleanup(db,'asset',asset.id,'cleanup',1000)).toBeTruthy();await expect(job()).rejects.toThrow(/admission/);});
 it('replaces definitive unavailable generations concurrently and preserves handles',async()=>{const old=await active();await db.query(`UPDATE ai_reference_assets SET status='failed',diagnostic='{"code":"asset_unavailable","reason":"expired"}' WHERE id=$1`,[old.id]);const rows=await Promise.all([l.replaceUnavailableReference(db,scope,old.id),l.replaceUnavailableReference(db,scope,old.id)]);expect(rows[0]?.id).toBe(rows[1]?.id);expect(rows[0]?.id).not.toBe(old.id);expect((await a.getReferenceAsset(db,scope,old.id))?.provider_id).toBe('ta_old');const fresh=rows[0]!;const c=(await a.claimReferenceAsset(db,scope,fresh.id,'worker',1000))!;await a.persistReferenceAsset(db,scope,fresh.id,c.fence,{status:'uncertain'});expect(await l.replaceUnavailableReference(db,scope,fresh.id)).toBeNull();});
 it('retries provider cleanup failures, permits later explicit re-registration, preserves uncertainty',async()=>{const asset=await active();await l.retireReferenceAsset(db,scope,asset.id);const lease=(await l.claimReferenceCleanup(db,'asset',asset.id,'cleanup',1000))!;await l.finishReferenceCleanup(db,lease,false,10);expect((await a.getReferenceAsset(db,scope,asset.id))?.provider_id).toBe('ta_old');expect(await l.claimReferenceCleanup(db,'asset',asset.id,'again',1000)).toBeNull();await db.query("UPDATE ai_reference_assets SET cleanup_next_at=now()-interval '1 second'");const retry=(await l.claimReferenceCleanup(db,'asset',asset.id,'again',1000))!;expect(retry.fence).toBeGreaterThan(lease.fence);await l.finishReferenceCleanup(db,retry,true,10);expect((await a.getReferenceAsset(db,scope,asset.id))?.cleaned_at).toBeTruthy();const fresh=await a.ensureReferenceAsset(db,scope,asset.sha256);expect(fresh.id).not.toBe(asset.id);const c=(await a.claimReferenceAsset(db,scope,fresh.id,'new',1000))!;await a.persistReferenceAsset(db,scope,fresh.id,c.fence,{status:'uncertain'});await l.retireReferenceAsset(db,scope,fresh.id);expect(await l.claimReferenceCleanup(db,'asset',fresh.id,'cleanup',1000)).toBeNull();});
 it('redacts expired uncertain sources, preserves settlement evidence and prevents restoration',async()=>{const j=await job(true);await db.query(`INSERT INTO ai_video_attempts(preparation_id,organization_id,app_id,attempt_number,reservation_id,provider_slot,credential_namespace,billing_context,submission_state) VALUES($1,'org','app',1,$2,'test','key','{"frozen":1}','uncertain')`,[j.id,randomUUID()]);await l.sweepReferenceRetention(db);expect((await p.getPreparation(db,j.id))?.request_json).toEqual({request:{model:'test',duration:5},selection:request.selection});await expect(db.query('UPDATE ai_video_preparations SET request_json=$2 WHERE id=$1',[j.id,request])).rejects.toThrow(/immutable/);const attempt=(await p.listPreparationAttempts(db,j.id))[0];expect(attempt.submission_state).toBe('uncertain');await p.markAttemptTerminal(db,attempt.id,attempt.fence,{status:'failed'});await p.acknowledgeAttemptSettlement(db,attempt.id,{receipt:'after-redaction'});expect((await p.getAttempt(db,attempt.id))?.settlement_receipt).toEqual({receipt:'after-redaction'});});
 it('blocks moves with active work and rejects admission after move starts',async()=>{const j=await job();await expect(db.query("UPDATE apps SET provisioning_status='migrating' WHERE id='app'")).rejects.toThrow(/reference work/);await db.query("UPDATE ai_video_preparations SET status='cancelled' WHERE id=$1",[j.id]);await db.query("UPDATE apps SET provisioning_status='migrating' WHERE id='app'");await expect(job()).rejects.toThrow(/admission/);});
 it('serializes concurrent deletion and admission on the app row',async()=>{const tx=await db.connect();await tx.query('BEGIN');await tx.query("DELETE FROM apps WHERE id='app'");const pending=job();await tx.query('COMMIT');tx.release();await expect(pending).rejects.toThrow(/admission/);expect((await db.query('SELECT * FROM ai_video_preparations')).rowCount).toBe(0);});

 it('enforces retained asset/byte/rate caps atomically, counting retired and uncertain until acknowledgement',async()=>{
  const limits={retainedAssets:2,retainedBytes:20,registrationsPerHour:3,concurrency:2};
  const rows=await Promise.all(['a','b','c'].map(async hash=>{try{return await l.ensureReferenceAssetLimited(db,scope,hash.repeat(64),10,limits);}catch{return null;}}));
  expect(rows.filter(Boolean)).toHaveLength(2);const first=rows.find(Boolean)!;
  await l.retireReferenceAsset(db,scope,first.id);
  await expect(l.ensureReferenceAssetLimited(db,scope,'d'.repeat(64),1,limits)).rejects.toThrow(/capacity/);
  const claim=(await l.claimReferenceCleanup(db,'asset',first.id,'cleaner',1000))!;await l.finishReferenceCleanup(db,claim,true);
  await l.ensureReferenceAssetLimited(db,scope,'d'.repeat(64),10,limits);
  await expect(l.ensureReferenceAssetLimited(db,scope,'e'.repeat(64),1,{...limits,retainedAssets:10,retainedBytes:100})).rejects.toThrow(/capacity/);
 });
 it('limits concurrent registration claims across independent workers',async()=>{
  const limits={retainedAssets:10,retainedBytes:100,registrationsPerHour:10,concurrency:2};
  const rows=await Promise.all(['a','b','c'].map(hash=>l.ensureReferenceAssetLimited(db,scope,hash.repeat(64),1,limits)));
  const claims=await Promise.all(rows.map(row=>l.claimReferenceAssetLimited(db,scope,row.id,randomUUID(),1000,limits)));
  expect(claims.filter(Boolean)).toHaveLength(2);
 });
 it('never re-registers an explicitly deleted uncertain upload until reconciliation and cleanup',async()=>{
  const row=await a.ensureReferenceAsset(db,scope,'a'.repeat(64));const c=(await a.claimReferenceAsset(db,scope,row.id,'worker',1000))!;
  await a.persistReferenceAsset(db,scope,row.id,c.fence,{status:'uncertain'});await l.retireReferenceAsset(db,scope,row.id);
  await expect(a.ensureReferenceAsset(db,scope,row.sha256)).rejects.toThrow(/unavailable/);
  await a.persistReferenceAsset(db,scope,row.id,c.fence,{status:'active',providerId:'ta_late'});
  await db.query("UPDATE ai_reference_assets SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[row.id]);
  const cleanup=(await l.claimReferenceCleanup(db,'asset',row.id,'cleanup',1000))!;await l.finishReferenceCleanup(db,cleanup,true);
  expect((await a.ensureReferenceAsset(db,scope,row.sha256)).id).not.toBe(row.id);
  expect((await a.getReferenceAsset(db,scope,row.id))?.provider_id).toBe('ta_late');
 });
 it('never redacts before source expiry and does not mutate archived source replicas',async()=>{
  const live=await job(),archived=await job(true);await db.query('UPDATE ai_video_preparations SET archived_after_move=$2 WHERE id=$1',[archived.id,randomUUID()]);
  await l.sweepReferenceRetention(db);expect((await p.getPreparation(db,live.id))?.request_json).toEqual(request);
  expect((await db.query('SELECT request_json FROM ai_video_preparations WHERE id=$1',[archived.id])).rows[0].request_json).toEqual(request);
  const asset=await active();await l.retireReferenceAsset(db,scope,asset.id);await db.query('UPDATE ai_reference_assets SET archived_after_move=$2 WHERE id=$1',[asset.id,randomUUID()]);
  expect(await l.listReadyReferenceCleanup(db)).toEqual([]);expect(await l.claimReferenceCleanup(db,'asset',asset.id,'cleanup',1000)).toBeNull();
 });
 it('allows settled healthy mappings to move with their exact namespace and blocks new source claims',async()=>{
  const asset=await active();await db.query("UPDATE apps SET provisioning_status='migrating' WHERE id='app'");
  expect((await a.getReferenceAsset(db,scope,asset.id))?.credential_namespace).toBe(scope.credentialNamespace);
  await expect(a.claimReferenceAssetValidation(db,scope,asset.id,'late',1000)).rejects.toThrow(/admission/);
  await expect(job()).rejects.toThrow(/admission/);
 });
 it('recovery preserves unresolved attempts through app deletion and one-way redaction',async()=>{
  const j=await job(true);await db.query(`INSERT INTO ai_video_attempts(preparation_id,organization_id,app_id,attempt_number,reservation_id,provider_slot,credential_namespace,billing_context,submission_state,provider_handle) VALUES($1,'org','app',1,$2,'test','key','{}','accepted','{"job":"upstream"}')`,[j.id,randomUUID()]);
  await db.query("DELETE FROM apps WHERE id='app'");await l.sweepReferenceRetention(db);const attempt=(await p.listAttemptRecovery(db))[0];
  const recovered=(await p.claimAttemptRecovery(db,attempt.id,'recovery',1000))!;expect(recovered.provider_handle).toEqual({job:'upstream'});
  await p.markAttemptTerminal(db,recovered.id,recovered.fence,{status:'completed',output:['https://video.invalid/output']});await p.acknowledgeAttemptSettlement(db,recovered.id,{reservationId:recovered.reservation_id});
  expect((await p.getAttempt(db,recovered.id))?.settlement_status).toBe('acknowledged');
 });

 it('copies settled records into a reserved destination and excludes the archived source from effects',async()=>{
  const asset=await active(),j=await job();await db.query("UPDATE ai_video_preparations SET status='completed',terminal_outcome='{\"status\":\"completed\",\"output\":[\"video\"]}',lease_owner='old-worker',lease_expires_at=now()-interval '1 second' WHERE id=$1",[j.id]);
  await db.query("UPDATE apps SET provisioning_status='migrating' WHERE id='app'");
  const destinationSchema=`${schema}_dest`,dest=new pg.Pool({connectionString:url,options:`-c search_path=${destinationSchema},public`});
  try {
   await dest.query(`CREATE SCHEMA ${destinationSchema}`);await dest.query('CREATE TABLE apps(id text PRIMARY KEY,organization_id text,owner_id text,provisioning_status text)');
   for(const name of ['056_ai_video_preparations.sql','057_ai_video_preparation_schedule.sql','058_ai_reference_lifecycle.sql'])await dest.query(await readFile(new URL(`../../../../../db/runtime-plane/${name}`,import.meta.url),'utf8'));
   await dest.query("INSERT INTO apps VALUES('app','org','owner','migration_target_reserved')");
   for(const table of ['ai_video_preparations','ai_video_attempts','ai_reference_asset_groups','ai_reference_assets']) {
    const rows=(await db.query(`SELECT * FROM ${table} WHERE app_id='app'`)).rows;
    for(const row of rows){delete row.archived_after_move;const keys=Object.keys(row);await dest.query(`INSERT INTO ${table} (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));}
    await db.query(`UPDATE ${table} SET archived_after_move=$1 WHERE app_id='app'`,[randomUUID()]);
   }
   expect(await a.getReferenceAsset(db,scope,asset.id)).toBeNull();expect(await l.listReadyReferenceCleanup(db)).toEqual([]);
   expect((await a.getReferenceAsset(dest,scope,asset.id))?.credential_namespace).toBe('key');
   await dest.query("UPDATE apps SET provisioning_status='ready' WHERE id='app'");
   expect(await a.claimReferenceAssetValidation(dest,scope,asset.id,'destination',1000)).toBeTruthy();
   expect((await a.ensureReferenceAsset(dest,{...scope,credentialNamespace:'rotated'},asset.sha256)).id).not.toBe(asset.id);
  }finally{await dest.query(`DROP SCHEMA ${destinationSchema} CASCADE`);await dest.end();}
 });
 it('serializes move admission behind an in-flight preparation admission',async()=>{
  const tx=await db.connect();await tx.query('BEGIN');
  await p.createPreparation(tx,{...scope,userId:'owner',model:'test',requestJson:request,deadline:new Date(Date.now()+60000),inputExpiresAt:new Date(Date.now()+86400000)});
  const moving=db.query("UPDATE apps SET provisioning_status='migrating' WHERE id='app'");
  await tx.query('COMMIT');tx.release();await expect(moving).rejects.toThrow(/reference work/);
  expect((await db.query("SELECT provisioning_status FROM apps WHERE id='app'")).rows[0].provisioning_status).toBe('ready');
 });
});
