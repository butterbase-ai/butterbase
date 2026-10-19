import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import * as repository from './video-preparations.js';
import { createVideoPreparationDriver, admitVideoPreparation } from './video-preparation.js';
import type { VideoPreparationHooks } from './video-preparation-hooks.js';
const url = process.env.PORTRAIT_TEST_DATABASE_URL;
const schema = `lifecycle_${randomUUID().replaceAll('-', '')}`;
let db: pg.Pool; let hooks: VideoPreparationHooks;
const ctx = () => ({ runtimePool: db, platformPool: db, region: 'test' });
const scope = { appId: 'app', organizationId: 'org', userId: 'owner', endUserSub: 'subject' };
const body = { model: 'test/video', prompt: 'test', input_images: ['https://images.example/portrait.png'], reference_declarations: [{ path: '/input_images/0', kind: 'ai_generated_fictional_character' }], prepare_references: 'on_rejection' };
const selection = { providerSlot: 'fake', credentialNamespace: 'v1', billingContext: { price: 1 } };
const fresh = () => createVideoPreparationDriver({ ...ctx(), hooks, workerId: randomUUID(), retryMs: 1 });
async function advance(id: string, n = 1) { for (let i = 0; i < n; i++) { await db.query('UPDATE ai_video_preparations SET next_action_at=now()'); await db.query('UPDATE ai_video_attempts SET next_action_at=now(),lease_expires_at=NULL'); await fresh().advanceVideoPreparation(id); } }
async function makeJob(overrides = {}) { return (await admitVideoPreparation(ctx(), hooks, scope, { ...body, ...overrides }))!; }
describe.skipIf(!url)('durable video lifecycle with real local PostgreSQL', () => {
 beforeAll(async () => {
  const parsed = new URL(url!); if (parsed.hostname !== '127.0.0.1' || parsed.port !== '15439' || parsed.pathname !== '/portrait_test') throw new Error('Requires isolated portrait_test database');
  db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 12 }); await db.query(`CREATE SCHEMA ${schema}`);
  for (const name of ['056_ai_video_preparations.sql', '057_ai_video_preparation_schedule.sql']) await db.query(await readFile(new URL(`../../../../../db/runtime-plane/${name}`, import.meta.url), 'utf8'));
  await db.query('CREATE TABLE test_usage (attempt_id uuid PRIMARY KEY)');
 });
 afterAll(async () => { if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); } });
 beforeEach(async () => {
  await db.query('TRUNCATE ai_video_preparations,ai_video_attempts,test_usage CASCADE'); const receipts = new Map<string, Record<string, unknown>>();
  hooks = {
   quote: vi.fn(async () => selection), authorize: vi.fn(async () => 'allowed'),
   loadImage: vi.fn(async () => ({ sha256: 'a'.repeat(64), bytesHandle: Buffer.from('image'), byteLength: 5, mimeType: 'image/png' })),
   prepareReference: vi.fn(async () => ({ status: 'active', referenceId: randomUUID(), assetId: 'asset-1' })),
   reserve: vi.fn(async () => ({ ok: true })), submit: vi.fn(async () => ({ status: 'accepted', handle: { id: 'provider-job' } })),
   poll: vi.fn(async () => ({ status: 'terminal', outcome: { status: 'completed', output: ['https://output.example/video.mp4'] } })), reconcile: vi.fn(async () => ({ status: 'uncertain' })),
   readReceipt: vi.fn(async (_, a) => receipts.get(a.reservation_id) ?? null),
   settle: vi.fn(async (_, a) => { const receipt = receipts.get(a.reservation_id) ?? { chargedUsd: a.terminal_outcome?.status === 'completed' ? 1 : 0 }; receipts.set(a.reservation_id, receipt); return receipt; }),
   writeUsage: vi.fn(async (tx, _, a) => { await tx.query('INSERT INTO test_usage VALUES ($1)', [a.id]); }), content: vi.fn(),
  };
 });
 it('persists admission immediately; ordinary requests bypass without downloads or provider calls', async () => {
  expect(await admitVideoPreparation(ctx(), hooks, scope, { model: 'test', prompt: 'plain' })).toBeNull(); const job = await makeJob();
  expect(job.status).toBe('pending'); expect(await repository.getPreparation(db, job.id)).toBeTruthy(); expect(hooks.loadImage).not.toHaveBeenCalled(); expect(hooks.reserve).not.toHaveBeenCalled(); expect(hooks.submit).not.toHaveBeenCalled();
 });
 it.each(['upfront','on_rejection'])('keeps registration pending then transitions accepted, polling and terminal (%s)', async mode => {
  if (mode === 'on_rejection') vi.mocked(hooks.submit).mockResolvedValueOnce({status:'terminal',outcome:{status:'failed',error:'input_face_privacy',retryPaths:['/input_images/0']}});
  vi.mocked(hooks.prepareReference).mockResolvedValueOnce({status:'processing',referenceId:'ref',nextAction:'poll',nextPollAt:new Date(0)});
  vi.mocked(hooks.poll).mockResolvedValueOnce({status:'pending',nextPollAt:new Date(0)});
  const job=await makeJob({prepare_references:mode});
  for(let i=0;i<12 && !vi.mocked(hooks.prepareReference).mock.calls.length;i++) await advance(job.id);
  expect(hooks.prepareReference).toHaveBeenCalledTimes(1);
  expect(await repository.getPreparation(db,job.id)).toMatchObject({status:'pending',stage:'preparing_references'});
  if (mode==='on_rejection') {
   const first=(await repository.listPreparationAttempts(db,job.id))[0];
   await repository.syncPreparationAttemptStage(db,first.id,first.fence);
   expect(await repository.getPreparation(db,job.id)).toMatchObject({status:'pending',stage:'preparing_references'});
  }
  const expectedSubmits=mode==='upfront'?1:2;
  for(let i=0;i<12 && vi.mocked(hooks.submit).mock.calls.length<expectedSubmits;i++) await advance(job.id);
  expect(await repository.getPreparation(db,job.id)).toMatchObject({status:'in_progress',stage:'polling'});
  await advance(job.id);
  expect(await repository.getPreparation(db,job.id)).toMatchObject({status:'in_progress',stage:'polling'});
  await advance(job.id);
  expect(await repository.getPreparation(db,job.id)).toMatchObject({status:'in_progress',stage:'settling'});
  await advance(job.id,7);
  expect(await repository.getPreparation(db,job.id)).toMatchObject({status:'completed',stage:null});
 });
 it('retains validated completion cost when generic output validation fails', async()=>{
  vi.mocked(hooks.submit).mockResolvedValue({status:'terminal',outcome:{status:'completed',output:[],providerCostUsd:0.4}});
  const job=await makeJob();await advance(job.id,12);
  expect((await repository.listPreparationAttempts(db,job.id))[0].terminal_outcome).toEqual({status:'failed',error:'invalid_provider_output',providerStatus:'completed',providerCostUsd:0.4});
 });
 it('finishes without customer polling across restart and duplicate workers', async () => {
  const job = await makeJob(); await advance(job.id, 3); await Promise.all([fresh().advanceVideoPreparation(job.id), fresh().advanceVideoPreparation(job.id)]); await advance(job.id, 12);
  expect(hooks.submit).toHaveBeenCalledTimes(1); expect(hooks.prepareReference).not.toHaveBeenCalled(); expect((await repository.getPreparation(db, job.id))?.status).toBe('completed'); expect((await db.query('SELECT * FROM test_usage')).rowCount).toBe(1);
 });
 it('never resubmits after an ambiguous transport timeout', async () => {
  vi.mocked(hooks.submit).mockRejectedValue(new Error('timeout')); const job = await makeJob(); await advance(job.id, 15);
  expect(hooks.submit).toHaveBeenCalledTimes(1); expect((await repository.listPreparationAttempts(db, job.id))[0].submission_state).toBe('uncertain'); expect(hooks.settle).not.toHaveBeenCalled();
 });
 it('retries one declared privacy rejection after independent settlement under same public id', async () => {
  vi.mocked(hooks.submit).mockResolvedValueOnce({ status: 'terminal', outcome: { status: 'failed', error: 'input_face_privacy', retryPaths: ['/input_images/0'] } });
  const job = await makeJob(); await advance(job.id, 28); expect(hooks.submit).toHaveBeenCalledTimes(2); expect(hooks.prepareReference).toHaveBeenCalledTimes(1);
  const attempts = await repository.listPreparationAttempts(db, job.id); expect(attempts).toHaveLength(2); expect(attempts.every(a => a.settlement_status === 'acknowledged')).toBe(true); expect(attempts[0].reservation_id).not.toBe(attempts[1].reservation_id); expect((await repository.getPreparation(db, job.id))?.status).toBe('completed');
 });
 it('rejects changed bytes before retry registration or second submission', async () => {
  vi.mocked(hooks.submit).mockResolvedValue({ status: 'terminal', outcome: { status: 'failed', error: 'input_face_privacy', retryPaths: ['/input_images/0'] } });
  vi.mocked(hooks.loadImage!).mockResolvedValueOnce({ sha256: 'a'.repeat(64), bytesHandle: Buffer.from('a'), byteLength: 1, mimeType: 'image/png' }).mockResolvedValue({ sha256: 'b'.repeat(64), bytesHandle: Buffer.from('b'), byteLength: 1, mimeType: 'image/png' });
  const job = await makeJob(); await advance(job.id, 24); expect(hooks.submit).toHaveBeenCalledTimes(1); expect(hooks.prepareReference).not.toHaveBeenCalled(); expect((await repository.getPreparation(db, job.id))?.terminal_outcome?.error).toBe('reference_changed');
 });
 it('replays receipt after runtime acknowledgement crash with one usage record', async () => {
  vi.mocked(hooks.writeUsage).mockRejectedValueOnce(new Error('runtime unavailable')).mockImplementation(async (tx, _, a) => { await tx.query('INSERT INTO test_usage VALUES ($1)', [a.id]); });
  const job = await makeJob(); for (let i = 0; i < 20; i++) await advance(job.id).catch(() => {});
  expect(hooks.settle).toHaveBeenCalledTimes(1); expect((await db.query('SELECT * FROM test_usage')).rowCount).toBe(1); expect((await repository.getPreparation(db, job.id))?.status).toBe('completed');
 });
 it('handles cancellation and exhausted credits before dispatch', async () => {
  vi.mocked(hooks.authorize).mockResolvedValue('cancelled'); const cancelled = await makeJob(); await advance(cancelled.id, 5);
  expect((await repository.getPreparation(db, cancelled.id))?.status).toBe('cancelled'); expect(hooks.submit).not.toHaveBeenCalled();
  vi.mocked(hooks.authorize).mockResolvedValue('allowed'); vi.mocked(hooks.reserve).mockResolvedValue({ ok: false, error: 'insufficient_credits' }); const exhausted = await makeJob(); await advance(exhausted.id, 15);
  expect((await repository.getPreparation(db, exhausted.id))?.terminal_outcome?.error).toBe('insufficient_credits'); expect(hooks.submit).not.toHaveBeenCalled();
 });
 it('does not dispatch from a stale pre-claim snapshot after another worker accepted', async () => {
  const job=await makeJob();await advance(job.id,2);
  let unlock!:()=>void;let started!:()=>void;const paused=new Promise<void>(r=>{unlock=r;});const entered=new Promise<void>(r=>{started=r;});
  vi.mocked(hooks.reserve).mockImplementationOnce(async()=>{started();await paused;return {ok:true};});
  const stale=advance(job.id);await entered;
  await db.query("UPDATE ai_video_preparations SET lease_expires_at=now()-interval '1 second',next_action_at=now() WHERE id=$1",[job.id]);
  await fresh().advanceVideoPreparation(job.id);unlock();await stale;
  expect(hooks.submit).toHaveBeenCalledTimes(1);
 });
 it.each(['submission','poll'])('second privacy rejection is terminal (%s)', async phase => {
  const failure={status:'terminal',outcome:{status:'failed',error:'input_face_privacy',retryPaths:['/input_images/0']}} as const;
  if(phase==='submission') vi.mocked(hooks.submit).mockResolvedValue(failure as any);else vi.mocked(hooks.poll).mockResolvedValue(failure as any);
  const job=await makeJob();await advance(job.id,30);
  expect(hooks.submit).toHaveBeenCalledTimes(2);expect((await repository.listPreparationAttempts(db,job.id))).toHaveLength(2);expect((await repository.getPreparation(db,job.id))?.status).toBe('failed');
 });
 it('does not retry rejection naming undeclared slots and validates completion output', async()=>{
  vi.mocked(hooks.submit).mockResolvedValue({status:'terminal',outcome:{status:'failed',error:'input_face_privacy',retryPaths:['/input_images/8']}});
  const rejected=await makeJob();await advance(rejected.id,14);expect(hooks.submit).toHaveBeenCalledTimes(1);expect(hooks.prepareReference).not.toHaveBeenCalled();
  vi.mocked(hooks.submit).mockResolvedValue({status:'terminal',outcome:{status:'completed',output:[]}});
  const invalid=await makeJob();await advance(invalid.id,14);expect((await repository.getPreparation(db,invalid.id))?.terminal_outcome?.error).toBe('invalid_provider_output');
 });
 it('recovers a crash after durable dispatch claim without repeating the POST', async()=>{
  const job=await makeJob();const claimed=(await repository.claimPreparation(db,job.id,'crashed',90000))!;
  const attempt=(await repository.createAttempt(db,job.id,claimed.fence,selection))!;
  await repository.claimAttempt(db,attempt.id,job.id,claimed.fence,'crashed',90000);await repository.releasePreparation(db,job.id,claimed.fence);
  await advance(job.id,8);expect(hooks.submit).not.toHaveBeenCalled();expect(hooks.reconcile).toHaveBeenCalled();expect((await repository.getAttempt(db,attempt.id))?.submission_state).toBe('uncertain');
 });
 it('isolates settlement capacity from unresolved preparation and recovers deleted reservations', async()=>{
  const job=await makeJob();const claimed=(await repository.claimPreparation(db,job.id,'deleted',90000))!;
  const attempt=(await repository.createAttempt(db,job.id,claimed.fence,selection))!;await repository.releasePreparation(db,job.id,claimed.fence);
  await db.query('UPDATE ai_video_preparations SET deleted_at=now() WHERE id=$1',[job.id]);
  await fresh().tick('recover');await fresh().tick('settle');
  expect((await repository.getAttempt(db,attempt.id))?.settlement_status).toBe('acknowledged');expect(hooks.submit).not.toHaveBeenCalled();
 });
 it('upfront prepares before reserve, honours provider poll action, and avoids redownload for polling', async()=>{
  vi.mocked(hooks.prepareReference).mockResolvedValueOnce({status:'processing',referenceId:'ref',nextAction:'poll',nextPollAt:new Date(0)});
  const job=await makeJob({prepare_references:'upfront'});await advance(job.id,3);expect(hooks.reserve).not.toHaveBeenCalled();expect(hooks.submit).not.toHaveBeenCalled();
  await advance(job.id,18);expect(hooks.loadImage).toHaveBeenCalledTimes(2);expect(hooks.prepareReference).toHaveBeenCalledTimes(2);expect(hooks.submit).toHaveBeenCalledTimes(1);
 });

 it('expires before any side effect at the independent preparation deadline',async()=>{
  const job=await repository.createPreparation(db,{...scope,model:body.model,requestJson:{request:body,selection},deadline:new Date(0),inputExpiresAt:new Date(Date.now()+86400000)});
  await advance(job.id);expect((await repository.getPreparation(db,job.id))?.status).toBe('expired');expect(hooks.loadImage).not.toHaveBeenCalled();expect(hooks.reserve).not.toHaveBeenCalled();expect(hooks.submit).not.toHaveBeenCalled();
 });
 it('does not let slow preparation occupy settlement lane capacity',async()=>{
  const preparing=await makeJob();const settling=await makeJob();const claim=(await repository.claimPreparation(db,settling.id,'setup',90000))!;const a=(await repository.createAttempt(db,settling.id,claim.fence,selection))!;
  await repository.markAttemptTerminal(db,a.id,a.fence,{status:'failed',error:'test'});await repository.releasePreparation(db,settling.id,claim.fence);
  let release!:()=>void;let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});const blocked=new Promise<void>(r=>{release=r;});
  vi.mocked(hooks.loadImage!).mockImplementationOnce(async()=>{entered();await blocked;return{sha256:'a'.repeat(64),bytesHandle:Buffer.from('a'),byteLength:1,mimeType:'image/png'};});
  const slow=fresh().advanceVideoPreparation(preparing.id);await started;await fresh().tick('settle');
  expect((await repository.getAttempt(db,a.id))?.settlement_status).toBe('acknowledged');release();await slow;
 });

});
