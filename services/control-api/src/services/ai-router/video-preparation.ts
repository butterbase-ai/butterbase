import { randomUUID } from 'node:crypto';
import * as p from './video-preparations.js';
import { loadReferenceImage } from './reference-image.js';
import type { AssetScope } from './reference-assets.js';
import type { PreparationContext, PreparationScope, PreparationSelection, VideoPreparationHooks, PreparationProviderResult, ReferenceProgress } from './video-preparation-hooks.js';
export const PREPARATION_DEFAULTS = Object.freeze({ deadlineMs: 600_000, retentionMs: 86_400_000, leaseMs: 90_000, retryMs: 5_000, batchSize: 8, scopeConcurrency: 2, operationTimeoutMs: 45_000 });
/** Internal deployment knobs, independent of the legacy two-hour sweeper window. */
export function videoPreparationSettings(env: NodeJS.ProcessEnv = process.env) {
 const number = (name: string, fallback: number, min: number, max: number) => {
  if (env[name] === undefined) return fallback;
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
 };
 return { ...PREPARATION_DEFAULTS,
  deadlineMs: number('VIDEO_PREPARATION_DEADLINE_MS', PREPARATION_DEFAULTS.deadlineMs, 1_000, 600_000),
  retryMs: number('VIDEO_PREPARATION_RETRY_MS', PREPARATION_DEFAULTS.retryMs, 1_000, 60_000),
 };
}
export class PreparationOptionError extends Error { readonly statusCode = 400; readonly code = 'UNSUPPORTED_REFERENCE_PREPARATION'; }
export interface PreparationEnvelope { request: Record<string, unknown>; selection: PreparationSelection }
export function preparationEnvelope(job: p.PreparationRow): PreparationEnvelope { return job.request_json as unknown as PreparationEnvelope; }
export function preparationAssetScope(job: p.PreparationRow): AssetScope {
 const { selection } = preparationEnvelope(job);
 return { organizationId: job.organization_id, appId: job.app_id, endUserSub: job.end_user_sub, providerSlot: selection.providerSlot, credentialNamespace: selection.credentialNamespace };
}
export function declaredReferencePaths(request: Record<string, unknown>): string[] {
 const declarations = request.reference_declarations as { path: string; kind: string }[] | undefined;
 return declarations?.map(x => x.path) ?? [];
}
/** Admission is metadata-only; downloads, credit reservations and provider POSTs run in worker. */
export async function admitVideoPreparation(ctx: PreparationContext, hooks: VideoPreparationHooks | null, scope: PreparationScope, request: Record<string, unknown>): Promise<p.PreparationRow | null> {
 if (!declaredReferencePaths(request).length) return null;
 const selection = await hooks?.quote(ctx, scope, request);
 if (!selection) throw new PreparationOptionError('Reference preparation is not enabled for this app and model');
 return p.createPreparation(ctx.runtimePool, { ...scope, model: String(request.model), requestJson: { request, selection }, deadline: new Date(Date.now() + videoPreparationSettings().deadlineMs), inputExpiresAt: new Date(Date.now() + PREPARATION_DEFAULTS.retentionMs) });
}
export function referenceSource(request: Record<string, unknown>, path: string): string {
 const match = /^\/(input_images|frame_images|input_references)\/(0|[1-9]\d*)$/.exec(path);
 if (!match) throw new PreparationOptionError('Invalid reference declaration path');
 const value = (request[match[1]] as unknown[])?.[Number(match[2])];
 if (typeof value === 'string') return value;
 const entry = value as Record<string, unknown> | undefined;
 const image = entry?.image_url;
 if (entry?.type === 'image_url' && typeof image === 'object' && image && typeof (image as { url?: unknown }).url === 'string') return (image as { url: string }).url;
 throw new PreparationOptionError('Declaration must identify an image reference');
}
function safeOutcome(outcome: p.TerminalOutcome): p.TerminalOutcome {
 if (outcome.status === 'completed' && (!outcome.output?.length || !outcome.output.every(value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } }))) return { status: 'failed', error: 'invalid_provider_output' };
 return outcome;
}
function eligibleRetry(job: p.PreparationRow, outcome: p.TerminalOutcome): boolean {
 const request = preparationEnvelope(job).request;
 const paths = declaredReferencePaths(request);
 const rejected = outcome.retryPaths;
 return request.prepare_references !== 'upfront' && outcome.status === 'failed' && outcome.error === 'input_face_privacy'
  && Array.isArray(rejected) && rejected.length > 0 && new Set(rejected).size === rejected.length && rejected.every(path => typeof path === 'string' && paths.includes(path));
}
export function createVideoPreparationDriver(options: PreparationContext & { hooks: VideoPreparationHooks; workerId?: string; retryMs?: number; leaseMs?: number; operationTimeoutMs?: number }) {
 const { runtimePool: db } = options; const ctx: PreparationContext = options;
 // Every hook is bounded; a timed-out paid POST stays uncertain even if its late
 // result arrives. Provider binding must also abort network IO at its own timeout.
 const hooks = new Proxy(options.hooks, { get(target, property) {
  const value = Reflect.get(target, property); if (typeof value !== 'function') return value;
  return (...args: unknown[]) => {
   let timer: ReturnType<typeof setTimeout>;
   const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Preparation operation timed out')), options.operationTimeoutMs ?? PREPARATION_DEFAULTS.operationTimeoutMs); });
   return Promise.race([Promise.resolve().then(() => value.apply(target, args)), timeout]).finally(() => clearTimeout(timer));
  };
 } });
 const worker = options.workerId ?? randomUUID(); const retryMs = options.retryMs ?? videoPreparationSettings().retryMs; const leaseMs = options.leaseMs ?? PREPARATION_DEFAULTS.leaseMs;
 const later = () => new Date(Date.now() + retryMs);
 async function scheduleJob(job: p.PreparationRow, when = later(), progress = job.reference_progress) {
  await db.query(`UPDATE ai_video_preparations SET next_action_at=$3,reference_progress=$4,updated_at=now() WHERE id=$1 AND fence=$2 AND lease_expires_at>now()`, [job.id, job.fence, when, progress]);
 }
 async function freshAuthority(job: p.PreparationRow, requireDeadline = true): Promise<boolean> {
  if (await hooks.authorize(ctx, job) !== 'allowed') return false;
  const found = await db.query(`SELECT id FROM ai_video_preparations WHERE id=$1 AND fence=$2 AND lease_expires_at>now() AND deleted_at IS NULL AND archived_after_move IS NULL AND status IN ('pending','in_progress') AND (NOT $3 OR deadline>now())`, [job.id, job.fence, requireDeadline]);
  return found.rowCount === 1;
 }
 async function storeResult(attempt: p.AttemptRow, result: PreparationProviderResult) {
  if (result.status === 'accepted') {
   if (!result.handle || !Object.keys(result.handle).length) await p.markAttemptUncertain(db, attempt.id, attempt.fence, { code: 'missing_provider_handle' });
   else await p.markAttemptAccepted(db, attempt.id, attempt.fence, result.handle);
  } else if (result.status === 'terminal') await p.markAttemptTerminal(db, attempt.id, attempt.fence, safeOutcome(result.outcome));
  else if (attempt.submission_state === 'submitting') await p.markAttemptUncertain(db, attempt.id, attempt.fence, { code: 'acceptance_unknown' });
  await db.query(`UPDATE ai_video_attempts SET next_action_at=$3,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND fence=$2 AND submission_state!='submitting'`, [attempt.id, attempt.fence, result.status === 'pending' ? result.nextPollAt ?? later() : later()]);
 }
 async function settleAttempt(attempt: p.AttemptRow): Promise<void> {
  if (attempt.settlement_status !== 'pending') return;
  await db.query("UPDATE ai_video_attempts SET next_action_at=$2 WHERE id=$1 AND settlement_status='pending'", [attempt.id, later()]);
  const job = await p.getPreparation(db, attempt.preparation_id); if (!job) return;
  if (await hooks.authorize(ctx, job) === 'region_mismatch') return;
  // Control transaction commits first. Receipt reread survives a lost response/crash.
  const receipt = await hooks.readReceipt(ctx, attempt) ?? await hooks.settle(ctx, attempt, job);
  const tx = await db.connect();
  try {
   await tx.query('BEGIN');
   if (await p.acknowledgeAttemptSettlement(tx, attempt.id, receipt)) await options.hooks.writeUsage(tx, job, attempt, receipt);
   await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
 }
 async function advanceVideoPreparation(jobId: string): Promise<void> {
  // Atomic claim includes scope capacity, avoiding check-then-act races across processes.
  const tx = await db.connect(); let job: p.PreparationRow | null = null;
  try {
   await tx.query('BEGIN');
   const base = await p.getPreparation(tx, jobId);
   if (base) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(preparationAssetScope(base))]);
    const count = await tx.query<{ count: string }>(`SELECT count(*) FROM ai_video_preparations WHERE organization_id=$1 AND app_id=$2 AND end_user_sub IS NOT DISTINCT FROM $3 AND lease_expires_at>now() AND archived_after_move IS NULL AND request_json->'selection'->>'providerSlot'=$4 AND request_json->'selection'->>'credentialNamespace'=$5`, [base.organization_id,base.app_id,base.end_user_sub,preparationEnvelope(base).selection.providerSlot,preparationEnvelope(base).selection.credentialNamespace]);
    if (Number(count.rows[0].count) < PREPARATION_DEFAULTS.scopeConcurrency && base.next_action_at <= new Date()) job = await p.claimPreparation(tx, jobId, worker, leaseMs);
   }
   await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  if (!job) return;
  try {
   await scheduleJob(job);
   const attempts = await p.listPreparationAttempts(db, job.id); const current = attempts.at(-1);
   if (current?.settlement_status === 'pending') { await settleAttempt(current); return; }
   if (current?.submission_state === 'accepted' || current?.submission_state === 'uncertain' || current?.submission_state === 'submitting') { await recoverAttempt(current); return; }
   if (current?.submission_state === 'terminal' && !(job.retry_consumed && current.attempt_number === 1)) {
    if (!job.retry_consumed && eligibleRetry(job, current.terminal_outcome!) && await p.consumePreparationRetry(db, job.id, job.fence)) { await p.setPreparationStage(db, job.id, job.fence, 'preparing_references'); return; }
    await p.finishPreparation(db, job.id, job.fence, current.terminal_outcome!); return;
   }
   const authority = await hooks.authorize(ctx, job);
   if (authority === 'region_mismatch') return;
   if (authority === 'cancelled' || job.deadline <= new Date()) {
    const outcome: p.TerminalOutcome = { status: authority === 'cancelled' ? 'cancelled' : 'expired' };
    if (current?.submission_state === 'created') await p.markAttemptTerminal(db, current.id, current.fence, outcome);
    else await p.finishPreparation(db, job.id, job.fence, outcome);
    return;
   }
   const { request, selection } = preparationEnvelope(job); const paths = declaredReferencePaths(request);
   const progress: Record<string, ReferenceProgress> = { ...job.reference_progress };
   const uncaptured = paths.find(path => !progress[path]?.sha256);
   if (uncaptured) {
    if (!await freshAuthority(job)) return;
    const image = await (hooks.loadImage ?? loadReferenceImage)(preparationAssetScope(job), referenceSource(request, uncaptured));
    progress[uncaptured] = { sha256: image.sha256 }; await scheduleJob(job, later(), progress); return;
   }
   if (!job.input_identity) { await p.captureInputIdentity(db, job.id, job.fence, Object.fromEntries(paths.map(path => [path, { sha256: progress[path].sha256 }]))); return; }
   const prepare = job.retry_consumed || request.prepare_references === 'upfront';
   const preparationPaths = job.retry_consumed ? attempts[0].terminal_outcome!.retryPaths as string[] : paths;
   const needed = prepare ? preparationPaths.find(path => !progress[path]?.assetId) : undefined;
   if (needed) {
    const previous = progress[needed];
    if (previous.nextPollAt && new Date(previous.nextPollAt) > new Date()) { await scheduleJob(job, new Date(previous.nextPollAt)); return; }
    await p.setPreparationStage(db, job.id, job.fence, 'preparing_references');
    if (!await freshAuthority(job)) return;
    const image = previous.nextAction === 'poll' ? undefined : await (hooks.loadImage ?? loadReferenceImage)(preparationAssetScope(job), referenceSource(request, needed));
    if (image && image.sha256 !== job.input_identity[needed].sha256) { await p.finishPreparation(db, job.id, job.fence, { status: 'failed', error: 'reference_changed' }); return; }
    if (!await freshAuthority(job)) return;
    const result = await hooks.prepareReference(ctx, job, needed, previous, image);
    if (result.status === 'failed') { await p.finishPreparation(db, job.id, job.fence, { status: 'failed', error: result.errorCode }); return; }
    progress[needed] = { sha256: previous.sha256, referenceId: result.referenceId, ...(result.status === 'active' ? { assetId: result.assetId } : { nextAction: result.nextAction, nextPollAt: result.nextPollAt.toISOString() }) };
    await scheduleJob(job, result.status === 'processing' ? result.nextPollAt : later(), progress); return;
   }
   const attempt = await p.createAttempt(db, job.id, job.fence, selection); if (!attempt || attempt.submission_state !== 'created') return;
   if (!await freshAuthority(job)) return;
   const reserved = await hooks.reserve(ctx, attempt, job);
   if (!reserved.ok) { await p.markAttemptTerminal(db, attempt.id, attempt.fence, { status: 'failed', error: 'error' in reserved ? reserved.error : 'reservation_failed' }); return; }
   if (!await freshAuthority(job)) return;
   const claimed = await p.claimAttempt(db, attempt.id, job.id, job.fence, worker, leaseMs);
   // Inspect atomic returned state, never grant POST from stale pre-claim read.
   if (!claimed || claimed.submission_state !== 'submitting') return;
   await p.setPreparationStage(db, job.id, job.fence, 'submitting');
   if (!await freshAuthority(job)) { await p.markAttemptTerminal(db, claimed.id, claimed.fence, { status: 'cancelled' }); return; }
   const fenceCheck = await db.query(`SELECT id FROM ai_video_attempts WHERE id=$1 AND fence=$2 AND submission_state='submitting' AND lease_expires_at>now() AND archived_after_move IS NULL`, [claimed.id, claimed.fence]);
   if (!fenceCheck.rowCount) return;
   try { await storeResult(claimed, await hooks.submit(ctx, claimed, job, Object.fromEntries(paths.flatMap(path => progress[path].assetId ? [[path, progress[path].assetId!]] : [])))); }
   catch { await p.markAttemptUncertain(db, claimed.id, claimed.fence, { code: 'acceptance_unknown' }); }
  } catch (error) {
   // Capacity/transient failures are retried on the persisted schedule; never log source URLs.
   if ((error as { code?: string }).code !== 'REFERENCE_IMAGE_CAPACITY_EXCEEDED') throw error;
  } finally { await p.releasePreparation(db, job.id, job.fence); }
 }
 async function recoverAttempt(attempt: p.AttemptRow): Promise<void> {
  if (attempt.next_action_at > new Date()) return;
  const job = await p.getPreparation(db, attempt.preparation_id); if (!job) return;
  if (await hooks.authorize(ctx, job) === 'region_mismatch') return;
  const claimed = await p.claimAttemptRecovery(db, attempt.id, worker, leaseMs); if (!claimed) return;
  if (claimed.diagnostic?.recoveryMode === 'reservation_only') { await p.markAttemptTerminal(db, claimed.id, claimed.fence, { status: job.deleted_at ? 'cancelled' : 'expired' }); return; }
  try {
   if (await hooks.authorize(ctx, job) === 'region_mismatch') return;
   const result = claimed.submission_state === 'accepted' ? await hooks.poll(ctx, claimed, job) : await hooks.reconcile(ctx, claimed, job);
   await storeResult(claimed, result);
  } catch { await db.query('UPDATE ai_video_attempts SET next_action_at=$3,lease_expires_at=NULL,lease_owner=NULL WHERE id=$1 AND fence=$2', [claimed.id, claimed.fence, later()]); }
 }
 /** Independent bounded lanes; callers run each on its own timer. */
 async function tick(lane: 'prepare' | 'poll' | 'settle' | 'recover', limit: number = PREPARATION_DEFAULTS.batchSize): Promise<void> {
  let jobs: { id: string }[] = []; let attempts: p.AttemptRow[] = [];
  if (lane === 'prepare') jobs = (await db.query(`SELECT p.id FROM ai_video_preparations p WHERE p.archived_after_move IS NULL AND p.deleted_at IS NULL AND p.status IN ('pending','in_progress') AND p.next_action_at<=now() AND (p.lease_expires_at IS NULL OR p.lease_expires_at<=now()) AND NOT EXISTS (SELECT 1 FROM ai_video_attempts a WHERE a.preparation_id=p.id AND a.submission_state IN ('accepted','submitting','uncertain')) ORDER BY p.next_action_at LIMIT $1`, [limit])).rows;
  else if (lane === 'settle') attempts = (await db.query<p.AttemptRow>(`SELECT * FROM ai_video_attempts WHERE archived_after_move IS NULL AND settlement_status='pending' AND next_action_at<=now() ORDER BY next_action_at LIMIT $1`, [limit])).rows;
  else attempts = (await db.query<p.AttemptRow>(`SELECT * FROM ai_video_attempts WHERE archived_after_move IS NULL AND next_action_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<=now()) AND ${lane === 'poll' ? "submission_state='accepted'" : "(submission_state IN ('submitting','uncertain') OR (submission_state='created' AND EXISTS (SELECT 1 FROM ai_video_preparations p WHERE p.id=preparation_id AND (p.deleted_at IS NOT NULL OR p.deadline<=now() OR p.status NOT IN ('pending','in_progress')))))"} ORDER BY next_action_at LIMIT $1`, [limit])).rows;
  // Bounded concurrency, not a serial queue that one slow item can block indefinitely.
  const results = await Promise.allSettled(jobs.length ? jobs.map(job => advanceVideoPreparation(job.id)) : attempts.map(a => lane === 'settle' ? settleAttempt(a) : recoverAttempt(a)));
  if (results.some(result => result.status === 'rejected')) throw new Error('Video preparation lane contains retryable failures');
 }
 return { advanceVideoPreparation, settleAttempt, recoverAttempt, tick };
}
