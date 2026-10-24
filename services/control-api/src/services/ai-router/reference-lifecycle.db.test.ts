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
 // Test-only witness runs after the lifecycle BEFORE trigger but while the app
 // still exists: direct DELETE and FK cascade must already have tombstones.
 beforeAll(async()=>{await db.query(`CREATE FUNCTION verify_teardown_tombstones() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM apps WHERE id=OLD.id)
   OR EXISTS(SELECT 1 FROM ai_reference_assets WHERE app_id=OLD.id AND archived_after_move IS NULL AND cleaned_at IS NULL AND NOT cleanup_pending)
   OR EXISTS(SELECT 1 FROM ai_reference_asset_groups WHERE app_id=OLD.id AND archived_after_move IS NULL AND cleaned_at IS NULL AND NOT cleanup_pending)
  THEN RAISE EXCEPTION 'tombstones must precede app removal'; END IF;
  RETURN OLD;
 END $$;CREATE TRIGGER zz_verify_teardown BEFORE DELETE ON apps FOR EACH ROW EXECUTE FUNCTION verify_teardown_tombstones()`);});
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
 it('redacts expired archived sources while excluding their provider effects',async()=>{
  const live=await job(),archived=await job(true);await db.query('UPDATE ai_video_preparations SET archived_after_move=$2 WHERE id=$1',[archived.id,randomUUID()]);
  await l.sweepReferenceRetention(db);expect((await p.getPreparation(db,live.id))?.request_json).toEqual(request);
  expect((await db.query('SELECT request_json FROM ai_video_preparations WHERE id=$1',[archived.id])).rows[0].request_json).toEqual({request:{model:'test',duration:5},selection:request.selection});
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
  const asset=await active(),j=await job(true);await db.query('UPDATE ai_video_preparations SET input_identity=$2,reference_progress=$3 WHERE id=$1',[j.id,{'/input_images/0':{sha256:asset.sha256}},{'/input_images/0':{sha256:asset.sha256,referenceId:asset.id,assetId:'ta_old'}}]);await db.query("UPDATE ai_video_preparations SET status='completed',terminal_outcome='{\"status\":\"completed\",\"output\":[\"video\"]}',lease_owner='old-worker',lease_expires_at=now()-interval '1 second' WHERE id=$1",[j.id]);
  await db.query(`INSERT INTO ai_video_attempts(preparation_id,organization_id,app_id,attempt_number,reservation_id,provider_slot,credential_namespace,billing_context,submission_state,terminal_outcome,terminal_at,settlement_status,settlement_receipt,settled_at) VALUES($1,'org','app',1,$2,'test','key','{"frozen":1}','terminal','{"status":"completed","output":["video"]}',now(),'acknowledged','{"receipt":"kept"}',now())`,[j.id,randomUUID()]);
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
   const sourceBefore=(await db.query('SELECT * FROM ai_video_preparations WHERE id=$1',[j.id])).rows[0];
   const attemptsBefore=(await db.query('SELECT * FROM ai_video_attempts')).rows;
   await l.sweepReferenceRetention(db);await l.sweepReferenceRetention(dest);
   for(const copy of [db,dest]) {
    const erased=(await copy.query('SELECT * FROM ai_video_preparations WHERE id=$1',[j.id])).rows[0];
    expect(erased.request_json).toEqual({request:{model:'test',duration:5},selection:request.selection});
    for(const key of ['id','input_identity','reference_progress','terminal_outcome'])expect(erased[key]).toEqual(sourceBefore[key]);
    const attempts=(await copy.query('SELECT * FROM ai_video_attempts')).rows;
    expect(attempts.map(({archived_after_move,...rest})=>rest)).toEqual(attemptsBefore.map(({archived_after_move,...rest})=>rest));
    await expect(copy.query('UPDATE ai_video_preparations SET request_json=$2 WHERE id=$1',[j.id,request])).rejects.toThrow(/immutable/);
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
 it.each(['preparation','asset','group','cleanup','recovery'] as const)('never waits child-to-app for an existing %s claim during deletion; retries contention',async kind=>{
  const j=await job(),asset=await a.ensureReferenceAsset(db,scope,'b'.repeat(64)),group=await a.ensureReferenceGroup(db,scope);
  if(kind==='cleanup')await l.retireReferenceAsset(db,scope,asset.id);
  if(kind==='recovery')await db.query("UPDATE ai_reference_assets SET status='uncertain' WHERE id=$1",[asset.id]);
  const claim=()=>kind==='preparation'?p.claimPreparation(db,j.id,'worker',1000):kind==='asset'?a.claimReferenceAsset(db,scope,asset.id,'worker',1000):kind==='group'?a.claimReferenceGroup(db,scope,group.id,'worker',1000):kind==='cleanup'?l.claimReferenceCleanup(db,'asset',asset.id,'worker',1000):a.claimReferenceAssetRecovery(db,scope,asset.id,'worker',1000);
  const owner=await db.connect();
  try {
   await owner.query('BEGIN');await owner.query("SELECT id FROM apps WHERE id='app' FOR UPDATE");
   // The second connection must finish without waiting for the held app lock.
   // lock_timeout makes the original child->app wait fail deterministically.
   const worker=await db.connect();
   let result:unknown;
   try {
    await worker.query("SET lock_timeout='250ms'");
    const workerClaim=kind==='preparation'?p.claimPreparation(worker,j.id,'worker',1000):kind==='asset'?a.claimReferenceAsset(worker,scope,asset.id,'worker',1000):kind==='group'?a.claimReferenceGroup(worker,scope,group.id,'worker',1000):kind==='cleanup'?l.claimReferenceCleanup(worker,'asset',asset.id,'worker',1000):a.claimReferenceAssetRecovery(worker,scope,asset.id,'worker',1000);
    result=await workerClaim.catch(error=>({error:error.code}));
   } finally {await worker.query('RESET lock_timeout');worker.release();}
   await owner.query("DELETE FROM apps WHERE id='app'");
   expect((await owner.query('SELECT cleanup_pending FROM ai_reference_assets WHERE id=$1',[asset.id])).rows[0].cleanup_pending).toBe(true);
   await owner.query('ROLLBACK');
   expect(result).toBeNull();
   expect(await claim()).toBeTruthy(); // contention did not consume authority
   await owner.query('BEGIN');await owner.query("SELECT id FROM apps WHERE id='app' FOR UPDATE");
   await owner.query("DELETE FROM apps WHERE id='app'");await owner.query('COMMIT');
   expect((await db.query("SELECT * FROM apps WHERE id='app'")).rowCount).toBe(0);
   expect((await a.getReferenceAsset(db,scope,asset.id))?.cleanup_pending).toBe(true);
  } finally {await owner.query('ROLLBACK');owner.release();}
 });
 it.each(['migrating','migration_target_reserved'].flatMap(state=>['transition','direct','cascade'].map(teardown=>({state,teardown}))))('persists $teardown tombstones from $state',async({state,teardown})=>{
   await db.query("INSERT INTO apps VALUES('app','org','owner','ready') ON CONFLICT(id) DO UPDATE SET provisioning_status='ready'");
   const asset=await active(),group=await a.ensureReferenceGroup(db,scope);
   await db.query('UPDATE apps SET provisioning_status=$1 WHERE id=$2',[state,'app']);
   expect(await l.claimReferenceCleanup(db,'asset',asset.id,'forbidden',1000)).toBeNull();
   if(teardown==='transition') {
    await db.query("UPDATE apps SET provisioning_status='deleting' WHERE id='app'");
    expect((await a.getReferenceAsset(db,scope,asset.id))?.cleanup_pending).toBe(true);
    expect((await a.getReferenceGroup(db,scope,group.id))?.cleanup_pending).toBe(true);
    await db.query("DELETE FROM apps WHERE id='app'");
   } else if(teardown==='direct')await db.query("DELETE FROM apps WHERE id='app'");
   else {
    await db.query('CREATE TABLE teardown_parent(id text PRIMARY KEY)');
    await db.query("INSERT INTO teardown_parent VALUES('parent')");
    await db.query('ALTER TABLE apps ADD COLUMN parent_id text REFERENCES teardown_parent(id) ON DELETE CASCADE');
    await db.query("UPDATE apps SET parent_id='parent' WHERE id='app'");
    await db.query("DELETE FROM teardown_parent WHERE id='parent'");
    await db.query('ALTER TABLE apps DROP COLUMN parent_id');await db.query('DROP TABLE teardown_parent');
   }
   expect((await db.query("SELECT * FROM apps WHERE id='app'")).rowCount).toBe(0);
   expect((await a.getReferenceAsset(db,scope,asset.id))?.cleanup_pending).toBe(true);
   expect((await a.getReferenceGroup(db,scope,group.id))?.cleanup_pending).toBe(true);
 });

 it('persists late handles and cleanup retries while teardown owns the app lock',async()=>{
  const asset=await a.ensureReferenceAsset(db,scope,'c'.repeat(64));const lease=(await a.claimReferenceAsset(db,scope,asset.id,'worker',1000))!;
  await l.retireReferenceAsset(db,scope,asset.id);
  const owner=await db.connect(),worker=await db.connect();
  try {
   await owner.query('BEGIN');await owner.query("SELECT id FROM apps WHERE id='app' FOR UPDATE");await worker.query("SET lock_timeout='250ms'");
   expect(await a.persistReferenceAsset(worker,scope,asset.id,lease.fence,{status:'active',providerId:'late-handle'})).toBe(true);
   expect(await l.finishReferenceCleanup(worker,{...lease,kind:'asset'},false)).toBe(true);
   await owner.query("DELETE FROM apps WHERE id='app'");await owner.query('COMMIT');
   const retained=await a.getReferenceAsset(db,scope,asset.id);expect(retained?.provider_id).toBe('late-handle');expect(retained?.cleanup_pending).toBe(true);
  }finally{await owner.query('ROLLBACK');await worker.query('RESET lock_timeout');owner.release();worker.release();}
 });

 it('defers bounded retention retirement for locked or migrating apps then resumes',async()=>{
  const asset=await active(),group=await a.ensureReferenceGroup(db,scope);
  await db.query("UPDATE ai_reference_assets SET group_id=$1,created_at=now()-interval '25 hours'",[group.id]);
  await db.query("UPDATE ai_reference_asset_groups SET created_at=now()-interval '25 hours'");
  const owner=await db.connect(),worker=await db.connect();
  try {
   await owner.query('BEGIN');await owner.query("SELECT id FROM apps WHERE id='app' FOR UPDATE");await worker.query("SET lock_timeout='250ms'");
   await l.sweepReferenceRetention(worker);expect((await a.getReferenceAsset(worker,scope,asset.id))?.cleanup_pending).toBe(false);
   await owner.query('ROLLBACK');await owner.query("UPDATE apps SET provisioning_status='migrating' WHERE id='app'");
   await l.sweepReferenceRetention(worker);expect((await a.getReferenceAsset(worker,scope,asset.id))?.cleanup_pending).toBe(false);
   await owner.query("UPDATE apps SET provisioning_status='ready' WHERE id='app'");await l.sweepReferenceRetention(worker);
   expect((await a.getReferenceAsset(worker,scope,asset.id))?.cleanup_pending).toBe(true);
   expect((await a.getReferenceGroup(worker,scope,group.id))?.cleanup_pending).toBe(true);
   expect(await l.claimReferenceCleanup(worker,'group',group.id,'cleanup',1000)).toBeNull();
  }finally{await owner.query('ROLLBACK');await worker.query('RESET lock_timeout');owner.release();worker.release();}
 });

 it('locks the app first before replacement can hold an old child row',async()=>{
  const old=await active();await db.query(`UPDATE ai_reference_assets SET status='failed',diagnostic='{"code":"asset_unavailable","reason":"expired"}' WHERE id=$1`,[old.id]);
  const owner=await db.connect(),worker=await db.connect();let pending:Promise<unknown>|undefined;
  try {
   await owner.query('BEGIN');await owner.query("SELECT id FROM apps WHERE id='app' FOR UPDATE");await worker.query('BEGIN');
   const pid=(await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   pending=l.replaceUnavailableReference(worker,scope,old.id).catch(error=>({error:error.code}));
   let waiting=false;
   for(let i=0;i<100&&!waiting;i++) {waiting=(await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting; if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));}
   expect(waiting).toBe(true);
   const child=await owner.query('SELECT id FROM ai_reference_assets WHERE id=$1 FOR UPDATE NOWAIT',[old.id]).then(r=>r.rows[0].id).catch(error=>({error:error.code}));
   if(typeof child==='string') {await owner.query("DELETE FROM apps WHERE id='app'");await owner.query('COMMIT');}
   else await owner.query('ROLLBACK');
   await pending;expect(child).toBe(old.id);
   expect((await db.query('SELECT count(*)::integer AS count FROM ai_reference_assets')).rows[0].count).toBe(1);
  }finally{await owner.query('ROLLBACK');if(pending)await pending;await worker.query('ROLLBACK');owner.release();worker.release();}
 });

});
