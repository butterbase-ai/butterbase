import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPreparedOutputTestDb } from '../../../test/fixtures/prepared-output-db.js';
import * as outputs from './video-preparation-outputs.js';
import { maintainPreparedOutputCleanup } from './video-output-cleanup.js';
import * as preparations from './video-preparations.js';

describe.skipIf(!process.env.VIDEO_OUTPUT_TEST_DATABASE_URL)('independent retained-output cleanup lane (isolated PostgreSQL)', () => {
  let db: Awaited<ReturnType<typeof createPreparedOutputTestDb>>, scope: Awaited<ReturnType<typeof db.seed>>;
  beforeAll(async () => { db = await createPreparedOutputTestDb(); });
  beforeEach(async () => { await db.reset(); scope = await db.seed(); });
  afterAll(async () => { await db?.close(); });
  async function allocated(dispatched = true) {
    const row = (await outputs.ensurePreparedOutputs(db.pool, { attemptId: scope.attempt.id, attemptFence: 1, count: 1, bucket: 'test' }))![0];
    const claim = (await outputs.claimPreparedOutput(db.pool, row.id, { attemptFence: 1, worker: 'copy' }))!;
    await outputs.recordPreparedOutputMeasurement(db.pool, row.id, claim.fence, { sizeBytes: 128, sha256: 'a'.repeat(64), contentType: 'video/mp4' });
    await outputs.reservePreparedOutputCapacity(db.pool, row.id, claim.fence);
    if (dispatched) await outputs.markPreparedOutputUploadStarted(db.pool, row.id, claim.fence);
    return row;
  }
  const retire = () => outputs.requestPreparedOutputCleanup(db.pool, { attemptId: scope.attempt.id, attemptFence: 1, errorCode: 'delivery_failed' });
  it('drains tombstones without provider credentials and acknowledges only a current cleanup fence', async () => {
    const row = await allocated(); await retire();
    await db.pool.query('UPDATE ai_video_preparation_outputs SET cleanup_not_before=now() WHERE id=$1', [row.id]);
    let calls = 0;
    await maintainPreparedOutputCleanup(db.pool, { canWork: async () => true, remove: async () => { calls++; return true; } });
    expect(calls).toBe(1);
    expect((await outputs.listPreparedOutputs(db.pool, scope.attempt.id))[0]).toMatchObject({ state: 'deleted', capacity_reserved: false });
  });
  it('keeps retryable cleanup durable and refuses shared identities', async () => {
    const row = await allocated(); await retire();
    await db.pool.query('UPDATE ai_video_preparation_outputs SET cleanup_not_before=now() WHERE id=$1', [row.id]);
    await db.pool.query(`INSERT INTO storage_objects(app_id,organization_id,bucket,key,size_bytes) VALUES($1,$2,$3,$4,128)`, [scope.app,scope.org,row.bucket,row.object_key]);
    let calls = 0;
    await maintainPreparedOutputCleanup(db.pool, { canWork: async () => true, remove: async () => { calls++; return true; } });
    expect(calls).toBe(0); expect((await outputs.listPreparedOutputs(db.pool, scope.attempt.id))[0].state).toBe('cleanup_pending');
  });
  it('skips a moved/foreign home region and does not delete source archived work', async () => {
    await allocated(); await retire(); let calls=0;
    await maintainPreparedOutputCleanup(db.pool, { canWork: async () => false, remove: async () => { calls++; return true; } });
    expect(calls).toBe(0);
  });
  it('retires unfinished expired outputs and erases source evidence without a generation retry', async () => {
    scope = await db.seed(null, '-expiring', 1000);
    const row = await allocated(false);
    await new Promise(resolve => setTimeout(resolve,1100));
    let calls = 0;
    await maintainPreparedOutputCleanup(db.pool, { canWork: async () => true, remove: async () => { calls++; return true; } });
    expect((await outputs.listPreparedOutputs(db.pool, scope.attempt.id))[0]).toMatchObject({ state: 'deleted', source_handle: null });
    expect(calls).toBe(0);expect(row.object_id).toBeTruthy();
  });
  async function completedBytesBeforeDeadline() {
    scope=await db.seed(null,'-settlement',1000);
    const row=await allocated(false);
    const current=(await outputs.listPreparedOutputs(db.pool,scope.attempt.id))[0];
    await outputs.markPreparedOutputCopied(db.pool,row.id,current.fence);
    const ids=(await outputs.commitPreparedOutputMetadata(db.pool,{attemptId:scope.attempt.id,attemptFence:1}))!;
    return {row,ids};
  }
  it('retains immutable completed output across a delayed settlement after deadline, then publishes the charged receipt',async()=>{
    const {ids}=await completedBytesBeforeDeadline();
    expect(await preparations.markAttemptTerminal(db.pool,scope.attempt.id,1,{status:'completed',outputObjectIds:ids,providerCostUsd:0.2})).toBe(true);
    await new Promise(resolve=>setTimeout(resolve,1100));let removals=0;
    await maintainPreparedOutputCleanup(db.pool,{canWork:async()=>true,remove:async()=>{removals++;return true;}});
    const claimed=(await preparations.claimPreparation(db.pool,scope.job.id,'publish',90_000))!;
    await preparations.acknowledgeAttemptSettlement(db.pool,scope.attempt.id,{status:'settled',chargedUsd:0.24});
    await expect(outputs.finishStoredPreparation(db.pool,scope.job.id,claimed.fence)).resolves.toBe(true);
    expect(removals).toBe(0);
    expect((await db.pool.query('SELECT published_at FROM storage_objects WHERE id=$1',[ids[0]])).rows[0].published_at).toBeTruthy();
  });
  it('rechecks terminal completion after a stale cleanup scan before retiring metadata',async()=>{
    const {ids}=await completedBytesBeforeDeadline();
    await new Promise(resolve=>setTimeout(resolve,1100));let marked=false,removals=0;
    await maintainPreparedOutputCleanup(db.pool,{canWork:async()=>{
      if(!marked){marked=true;expect(await preparations.markAttemptTerminal(db.pool,scope.attempt.id,1,{status:'completed',outputObjectIds:ids,providerCostUsd:0.2})).toBe(true);}return true;
    },remove:async()=>{removals++;return true;}});
    expect(marked).toBe(true);expect(removals).toBe(0);
    expect((await outputs.listPreparedOutputs(db.pool,scope.attempt.id))[0].state).toBe('stored');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM storage_objects WHERE id=$1',[ids[0]])).rows[0].n).toBe(1);
  });
});
