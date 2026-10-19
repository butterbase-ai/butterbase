import type pg from 'pg';

/** Explicit runtime database only. Callers may pass an existing transaction. */
export type PreparationDb = pg.Pool | pg.PoolClient;
export type InputIdentity = Record<string, { sha256: string; objectId?: string; version?: string }>;
export type TerminalOutcome = {
  status: 'completed' | 'failed' | 'cancelled' | 'expired';
  output?: string[];
  error?: string;
  [key: string]: unknown;
};
export interface PreparationRow {
  id: string;
  organization_id: string;
  app_id: string;
  user_id: string;
  end_user_sub: string | null;
  model: string;
  request_json: Record<string, unknown>;
  input_identity: InputIdentity | null;
  next_action_at: Date;
  reference_progress: Record<string, import('./video-preparation-hooks.js').ReferenceProgress>;
  status: 'pending' | 'in_progress' | TerminalOutcome['status'];
  stage: 'preparing_references' | 'submitting' | 'polling' | 'settling' | null;
  terminal_outcome: TerminalOutcome | null;
  retry_consumed: boolean;
  deadline: Date;
  input_expires_at: Date;
  deleted_at: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  fence: number;
  created_at: Date;
}
export interface AttemptRow {
  id: string;
  preparation_id: string;
  app_id: string;
  organization_id: string;
  attempt_number: 1 | 2;
  reservation_id: string;
  next_action_at: Date;
  provider_slot: string;
  credential_namespace: string;
  billing_context: Record<string, unknown>;
  submission_state: 'created' | 'submitting' | 'accepted' | 'uncertain' | 'terminal';
  provider_handle: Record<string, unknown> | null;
  diagnostic: Record<string, unknown> | null;
  terminal_outcome: TerminalOutcome | null;
  terminal_at: Date | null;
  settlement_status: 'not_due' | 'pending' | 'acknowledged';
  settlement_receipt: Record<string, unknown> | null;
  settled_at: Date | null;
  fence: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
}
const live = `archived_after_move IS NULL`;
const leased = `fence = $2 AND lease_expires_at > now() AND ${live}`;
const mutable = `status IN ('pending','in_progress') AND deleted_at IS NULL`;
function leaseDuration(ms: number) { if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error('lease duration must be positive milliseconds'); return ms; }
function validateOutcome(outcome: TerminalOutcome) {
  if (outcome.status === 'completed' && !outcome.output?.some(x => typeof x === 'string' && x.length > 0)) throw new Error('completed outcome requires output');
}

/** Insert the stable public job before reserving or submitting anything. */
export async function createPreparation(db: PreparationDb, args: {
  organizationId: string; appId: string; userId: string; endUserSub: string | null;
  model: string; requestJson: Record<string, unknown>; deadline: Date; inputExpiresAt: Date;
}): Promise<PreparationRow> {
  const r = await db.query<PreparationRow>(`INSERT INTO ai_video_preparations
    (organization_id,app_id,user_id,end_user_sub,model,request_json,deadline,input_expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
  [args.organizationId,args.appId,args.userId,args.endUserSub,args.model,args.requestJson,args.deadline,args.inputExpiresAt]);
  return r.rows[0];
}
export async function getPreparation(db: PreparationDb, id: string): Promise<PreparationRow | null> {
  return (await db.query<PreparationRow>(`SELECT * FROM ai_video_preparations WHERE id=$1 AND ${live}`, [id])).rows[0] ?? null;
}
/** Null means another worker owns it, archived/deleted/terminal, or terminal. Expired jobs can be claimed for terminalization. */
export async function claimPreparation(db: PreparationDb, id: string, worker: string, leaseMs: number): Promise<PreparationRow | null> {
  return (await db.query<PreparationRow>(`UPDATE ai_video_preparations SET
    fence=fence+1, lease_owner=$2, lease_expires_at=now()+$3*interval '1 millisecond', updated_at=now()
    WHERE id=$1 AND ${live} AND ${mutable}
      AND (lease_expires_at IS NULL OR lease_expires_at<=now()) RETURNING *`, [id,worker,leaseDuration(leaseMs)])).rows[0] ?? null;
}
export async function releasePreparation(db: PreparationDb, id: string, fence: number): Promise<boolean> {
  return (await db.query(`UPDATE ai_video_preparations SET lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND ${leased}`, [id,fence])).rowCount === 1;
}
/** Capture once before first submission. Equal replay is idempotent; byte changes fail. */
export async function captureInputIdentity(db: PreparationDb, id: string, fence: number, identity: InputIdentity): Promise<boolean> {
  for (const [path, value] of Object.entries(identity)) {
    if (!path.startsWith('/') || !/^[0-9a-f]{64}$/.test(value.sha256)) throw new Error('invalid canonical path or sha256');
  }
  return (await db.query(`UPDATE ai_video_preparations SET input_identity=$3,updated_at=now()
    WHERE id=$1 AND ${leased} AND ${mutable} AND (input_identity IS NULL OR input_identity=$3::jsonb)`, [id,fence,JSON.stringify(identity)])).rowCount === 1;
}
export async function setPreparationStage(db: PreparationDb, id: string, fence: number, stage: PreparationRow['stage']): Promise<boolean> {
  return (await db.query(`UPDATE ai_video_preparations SET stage=$3,status='in_progress',updated_at=now() WHERE id=$1 AND ${leased} AND ${mutable}`, [id,fence,stage])).rowCount === 1;
}

/** Locks the public job and atomically creates/reuses its current attempt. */
export async function createAttempt(db: PreparationDb, id: string, fence: number, args: {
  providerSlot: string; credentialNamespace: string; billingContext: Record<string, unknown>;
}): Promise<AttemptRow | null> {
  const r = await db.query<AttemptRow>(`WITH owner AS (
    SELECT * FROM ai_video_preparations WHERE id=$1 AND ${leased} AND ${mutable} AND deadline>now() FOR UPDATE
  ) INSERT INTO ai_video_attempts (preparation_id,organization_id,app_id,attempt_number,reservation_id,provider_slot,credential_namespace,billing_context)
    SELECT id,organization_id,app_id,CASE WHEN retry_consumed THEN 2 ELSE 1 END,
      md5('ai-video-attempt-reservation:'||id::text||':'||CASE WHEN retry_consumed THEN '2' ELSE '1' END)::uuid,$3,$4,$5 FROM owner
    ON CONFLICT (preparation_id,attempt_number) DO UPDATE SET updated_at=ai_video_attempts.updated_at RETURNING *`,
  [id,fence,args.providerSlot,args.credentialNamespace,args.billingContext]);
  return r.rows[0] ?? null;
}
export async function getAttempt(db: PreparationDb, id: string): Promise<AttemptRow | null> {
  return (await db.query<AttemptRow>(`SELECT * FROM ai_video_attempts WHERE id=$1 AND ${live}`, [id])).rows[0] ?? null;
}
export async function listPreparationAttempts(db: PreparationDb, id: string): Promise<AttemptRow[]> {
  return (await db.query<AttemptRow>(`SELECT * FROM ai_video_attempts WHERE preparation_id=$1 AND ${live} ORDER BY attempt_number`, [id])).rows;
}
/**
 * created -> submitting is the only permission to POST. accepted claims poll only.
 * Expired submitting/uncertain is NEVER claimable: reconcile, never submit again.
 */
export async function claimAttempt(db: PreparationDb, id: string, preparationId: string, preparationFence: number, worker: string, leaseMs: number): Promise<AttemptRow | null> {
  return (await db.query<AttemptRow>(`WITH owner AS (
    SELECT id FROM ai_video_preparations WHERE id=$2 AND fence=$3 AND lease_expires_at>now()
      AND ${live} AND ${mutable} AND deadline>now() FOR UPDATE
  ) UPDATE ai_video_attempts SET fence=fence+1,lease_owner=$4,lease_expires_at=now()+$5*interval '1 millisecond',
      submission_state=CASE WHEN submission_state='created' THEN 'submitting' ELSE submission_state END, updated_at=now()
    WHERE id=$1 AND preparation_id IN (SELECT id FROM owner) AND ${live}
      AND submission_state IN ('created','accepted') AND (lease_expires_at IS NULL OR lease_expires_at<=now()) RETURNING *`,
  [id,preparationId,preparationFence,worker,leaseDuration(leaseMs)])).rows[0] ?? null;
}
/** Late confirmations may reconcile an uncertain POST with the original fence. */
export async function markAttemptAccepted(db: PreparationDb, id: string, fence: number, providerHandle: Record<string, unknown>): Promise<boolean> {
  return (await db.query(`UPDATE ai_video_attempts SET submission_state='accepted',provider_handle=$3,updated_at=now()
    WHERE id=$1 AND fence=$2 AND ${live} AND submission_state IN ('submitting','uncertain') AND provider_handle IS NULL`, [id,fence,providerHandle])).rowCount === 1;
}
export async function markAttemptUncertain(db: PreparationDb, id: string, fence: number, diagnostic: Record<string, unknown>): Promise<boolean> {
  return (await db.query(`UPDATE ai_video_attempts SET submission_state='uncertain',diagnostic=$3,updated_at=now()
    WHERE id=$1 AND fence=$2 AND ${live} AND submission_state='submitting'`, [id,fence,diagnostic])).rowCount === 1;
}
/** Immutable first terminal outcome; no billing/network side effects in this query. */
export async function markAttemptTerminal(db: PreparationDb, id: string, fence: number, outcome: TerminalOutcome): Promise<boolean> {
  validateOutcome(outcome);
  return (await db.query(`UPDATE ai_video_attempts SET submission_state='terminal',terminal_outcome=$3,terminal_at=now(),
    settlement_status='pending',updated_at=now() WHERE id=$1 AND fence=$2 AND ${live}
      AND submission_state IN ('created','submitting','accepted','uncertain')`, [id,fence,outcome])).rowCount === 1;
}
/** Caller settles idempotently by reservation_id first. Receipt + ack commit together. */
export async function acknowledgeAttemptSettlement(db: PreparationDb, id: string, receipt: Record<string, unknown>): Promise<boolean> {
  return (await db.query(`UPDATE ai_video_attempts SET settlement_receipt=$2,settled_at=now(),settlement_status='acknowledged',updated_at=now()
    WHERE id=$1 AND ${live} AND submission_state='terminal' AND settlement_status='pending'`, [id,receipt])).rowCount === 1;
}
export async function listUnsettledAttempts(db: PreparationDb, limit = 100): Promise<AttemptRow[]> {
  return (await db.query<AttemptRow>(`SELECT * FROM ai_video_attempts WHERE ${live} AND settlement_status='pending' ORDER BY created_at LIMIT $1`, [limit])).rows;
}
/** Eligibility (specific rejection + declaration) is the caller's policy decision. */
export async function consumePreparationRetry(db: PreparationDb, id: string, fence: number): Promise<boolean> {
  return (await db.query(`UPDATE ai_video_preparations SET retry_consumed=true,updated_at=now()
    WHERE id=$1 AND ${leased} AND ${mutable} AND deadline>now() AND NOT retry_consumed
    AND EXISTS (SELECT 1 FROM ai_video_attempts a WHERE a.preparation_id=$1 AND a.attempt_number=1
      AND a.terminal_outcome->>'status'='failed' AND a.settlement_status='acknowledged' AND a.archived_after_move IS NULL)`, [id,fence])).rowCount === 1;
}
/** Public completion waits for every attempt's receipt and a matching successful output. */
export async function finishPreparation(db: PreparationDb, id: string, fence: number, outcome: TerminalOutcome): Promise<boolean> {
  validateOutcome(outcome);
  return (await db.query(`UPDATE ai_video_preparations SET status=$3,terminal_outcome=$4,stage=NULL,updated_at=now()
    WHERE id=$1 AND ${leased} AND ${mutable}
      AND NOT EXISTS (SELECT 1 FROM ai_video_attempts a WHERE a.preparation_id=$1 AND a.settlement_status!='acknowledged')
      AND ($3!='completed' OR EXISTS (SELECT 1 FROM ai_video_attempts a WHERE a.preparation_id=$1 AND a.terminal_outcome=$4::jsonb))`,
  [id,fence,outcome.status,outcome])).rowCount === 1;
}
/** Move admission must call after writes are blocked to avoid an admission race. */
export async function hasBlockingPreparationWork(db: PreparationDb, appId: string): Promise<boolean> {
  const r = await db.query<{ blocked: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM ai_video_preparations WHERE app_id=$1 AND ${live} AND status IN ('pending','in_progress'))
    OR EXISTS (SELECT 1 FROM ai_video_attempts WHERE app_id=$1 AND ${live} AND settlement_status!='acknowledged')
    OR EXISTS (SELECT 1 FROM ai_reference_assets WHERE app_id=$1 AND ${live} AND (cleanup_pending OR status IN ('registering','pending','uncertain')))
    OR EXISTS (SELECT 1 FROM ai_reference_asset_groups WHERE app_id=$1 AND ${live} AND (cleanup_pending OR status IN ('registering','pending','uncertain'))) AS blocked`, [appId]);
  return r.rows[0].blocked;
}
/** Background recovery includes expired jobs so workers can explicitly expire them. */
export async function listPreparationWork(db: PreparationDb, limit = 100): Promise<PreparationRow[]> {
  return (await db.query<PreparationRow>(`SELECT * FROM ai_video_preparations WHERE ${live} AND ${mutable}
    AND (lease_expires_at IS NULL OR lease_expires_at<=now()) ORDER BY created_at LIMIT $1`, [limit])).rows;
}

const recoverableAttempt = `(submission_state IN ('submitting','uncertain','accepted')
  OR (submission_state='created' AND EXISTS (SELECT 1 FROM ai_video_preparations p
    WHERE p.id=ai_video_attempts.preparation_id AND (p.deleted_at IS NOT NULL OR p.deadline<=now()
      OR p.status NOT IN ('pending','in_progress')))))`;

/** Discover paid submissions/reservations needing reconciliation, including deleted apps. */
export async function listAttemptRecovery(db: PreparationDb, limit = 100): Promise<AttemptRow[]> {
  return (await db.query<AttemptRow>(`SELECT * FROM ai_video_attempts WHERE ${live}
    AND ${recoverableAttempt}
    AND (lease_expires_at IS NULL OR lease_expires_at<=now()) ORDER BY created_at LIMIT $1`, [limit])).rows;
}
/**
 * Recovery-only lease: NEVER authorizes a provider POST. Expired submitting
 * becomes uncertain, never created. Orphaned created records have diagnostic
 * recoveryMode=reservation_only, without claiming any upstream acceptance.
 * Works after parent deletion/deadline so
 * terminal outcomes and settlement remain recoverable.
 */
export async function claimAttemptRecovery(db: PreparationDb, id: string, worker: string, leaseMs: number): Promise<AttemptRow | null> {
  return (await db.query<AttemptRow>(`UPDATE ai_video_attempts SET fence=fence+1,lease_owner=$2,
    lease_expires_at=now()+$3*interval '1 millisecond',updated_at=now(),
    diagnostic=CASE WHEN submission_state='created' THEN '{"recoveryMode":"reservation_only"}'::jsonb ELSE diagnostic END,
    submission_state=CASE WHEN submission_state IN ('created','submitting') THEN 'uncertain' ELSE submission_state END
    WHERE id=$1 AND ${live} AND ${recoverableAttempt}
    AND (lease_expires_at IS NULL OR lease_expires_at<=now()) RETURNING *`, [id,worker,leaseDuration(leaseMs)])).rows[0] ?? null;
}
