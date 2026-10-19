import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
const f = vi.hoisted(() => ({ caller: { kind:'end_user', sub:'alice' } as any, job:null as any, attempts:[] as any[], create:vi.fn(), legacySubmit:vi.fn() }));
vi.mock('../services/ai-router/authorize-app-call.js', () => ({ authorizeAppAiCall:vi.fn(async () => ({ok:true,ownerId:'owner',caller:f.caller})) }));
vi.mock('../services/region-resolver.js', () => ({getRuntimeDbForApp:vi.fn(async () => ({})),resolveAppHomeRegion:vi.fn(async () => 'test')}));
vi.mock('../services/app-org-resolver.js', () => ({resolveOrgFromApp:vi.fn(async () => 'org')}));
vi.mock('../services/redis.js', () => ({ getRedisClient:vi.fn() }));
vi.mock('./ai-config.js', () => ({readAutoRefillState:vi.fn()}));
vi.mock('../services/ai-router/special-pricing.js', () => ({resolveMarkupPct:vi.fn(async () => ({pct:20,source:'global'}))}));
vi.mock('../services/ai-router/router.js', () => ({routeVideoSubmit:f.legacySubmit,routeVideoPoll:vi.fn(),settleVideoJob:vi.fn(),billedVideoCostUsd:vi.fn(),RouterError:class extends Error{},InsufficientCreditsError:class extends Error{}}));
vi.mock('../services/ai-router/video-preparations.js', () => ({createPreparation:f.create,getPreparation:vi.fn(async () => f.job),listPreparationAttempts:vi.fn(async () => f.attempts)}));
import { aiVideoRoutes } from './ai-videos.js';
import { setVideoPreparationHooks } from '../services/ai-router/video-preparation-hooks.js';
let app: ReturnType<typeof Fastify>; let hooks:any;
const body = {model:'fake/video',prompt:'test',input_images:['https://example.com/a.png'],reference_declarations:[{path:'/input_images/0',kind:'ai_generated_fictional_character'}]};
describe('durable preparation HTTP seam', () => {
 beforeEach(async () => {
  f.caller={kind:'end_user',sub:'alice'}; f.job={id:'job',app_id:'app',user_id:'owner',end_user_sub:'alice',status:'pending',model:'fake/video',deleted_at:null,created_at:new Date()}; f.attempts=[];
  vi.clearAllMocks(); f.create.mockImplementation(async (_db,args) => ({...f.job,request_json:args.requestJson}));
  hooks={quote:vi.fn(async () => ({providerSlot:'fake',credentialNamespace:'v1',billingContext:{}})),submit:vi.fn(),prepareReference:vi.fn(),content:vi.fn(async () => ({stream:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('video'));controller.close();}}),contentType:'video/mp4'}))}; setVideoPreparationHooks(hooks);
  app=Fastify(); app.decorate('controlDb',{} as any); await app.register(aiVideoRoutes);
 });
 afterEach(async () => {setVideoPreparationHooks(null);await app.close();});
 it('returns202 after durable insert with server-resolved scope and no provider invocation', async () => {
  const response=await app.inject({method:'POST',url:'/v1/app/videos/completions',payload:body});
  expect(response.statusCode).toBe(202); expect(response.json().job_id).toBe('job');
  expect(f.create.mock.calls[0][1]).toMatchObject({appId:'app',organizationId:'org',userId:'owner',endUserSub:'alice'}); expect(hooks.submit).not.toHaveBeenCalled(); expect(hooks.prepareReference).not.toHaveBeenCalled(); expect(f.legacySubmit).not.toHaveBeenCalled();
 });
 it.each(['upfront', 'retry'])('exposes only the public pending preparation stage for %s', async () => {
  f.job.status='pending'; f.job.stage='preparing_references';
  expect((await app.inject('/v1/app/videos/completions/job')).json()).toMatchObject({status:'pending',stage:'preparing_references'});
  for (const [status, stage] of [['in_progress','submitting'],['in_progress','polling'],['in_progress','settling'],['failed',null],['completed','preparing_references']]) {
   f.job.status=status; f.job.stage=stage;
   expect((await app.inject('/v1/app/videos/completions/job')).json()).not.toHaveProperty('stage');
  }
 });
 it('GET is read-only and preserves app/end-user isolation', async () => {
  expect((await app.inject('/v1/app/videos/completions/job')).statusCode).toBe(200); expect(hooks.submit).not.toHaveBeenCalled();
  f.caller={kind:'end_user',sub:'bob'}; expect((await app.inject('/v1/app/videos/completions/job')).statusCode).toBe(404);
  f.caller={kind:'owner'}; expect((await app.inject('/v1/foreign/videos/completions/job')).statusCode).toBe(404);
 });
 it('content uses authenticated stable job id and settled attempt', async () => {
  f.job.status='completed';f.job.terminal_outcome={status:'completed',output:['https://cdn.example/output.mp4']};f.attempts=[{terminal_outcome:f.job.terminal_outcome,settlement_status:'acknowledged'}];
  const response=await app.inject('/v1/app/videos/completions/job/content'); expect(response.statusCode).toBe(200);expect(response.body).toBe('video');expect(hooks.content).toHaveBeenCalledTimes(1);
  f.caller={kind:'end_user',sub:'bob'}; expect((await app.inject('/v1/app/videos/completions/job/content')).statusCode).toBe(404);expect(hooks.content).toHaveBeenCalledTimes(1);
 });
 it('rejects unsupported declared flow before legacy paid submission', async () => {
  hooks.quote.mockResolvedValue(null); const response=await app.inject({method:'POST',url:'/v1/app/videos/completions',payload:body});expect(response.statusCode).toBe(400);expect(f.create).not.toHaveBeenCalled();expect(f.legacySubmit).not.toHaveBeenCalled();
 });
});
