import type { PreparationDb } from './video-preparations.js';

/** Opaque credential namespace changes on credential/ownership rotation. */
export interface AssetScope { organizationId: string; appId: string; endUserSub: string | null; providerSlot: string; credentialNamespace: string }
export interface ReferenceRow {
  id: string; organization_id: string; app_id: string; end_user_sub: string | null;
  provider_slot: string; credential_namespace: string; provider_id: string | null;
  status: 'new' | 'registering' | 'pending' | 'active' | 'uncertain' | 'failed' | 'deleted';
  cleanup_pending: boolean; deleted_at: Date | null; cleaned_at: Date | null;
  fence: number; lease_owner: string | null; lease_expires_at: Date | null;
}
export interface ReferenceAssetRow extends ReferenceRow { sha256: string; group_id: string | null }
export interface ReferenceState { status: 'pending' | 'active' | 'uncertain' | 'failed'; providerId?: string; diagnostic?: Record<string, unknown> }
type Kind = 'group' | 'asset';
const tableFor = (kind: Kind) => kind === 'asset' ? 'ai_reference_assets' : 'ai_reference_asset_groups';
const scopeValues = (s: AssetScope) => [s.organizationId,s.appId,s.endUserSub,s.providerSlot,s.credentialNamespace];
const scopeSql = 'organization_id=$1 AND app_id=$2 AND end_user_sub IS NOT DISTINCT FROM $3::text AND provider_slot=$4 AND credential_namespace=$5';
const live = 'archived_after_move IS NULL';

async function ensure(db: PreparationDb, kind: Kind, scope: AssetScope, sha256?: string): Promise<ReferenceRow | ReferenceAssetRow> {
  const table = tableFor(kind);
  const values = scopeValues(scope); if (sha256 !== undefined) values.push(sha256);
  const columns = `organization_id,app_id,end_user_sub,provider_slot,credential_namespace${kind === 'asset' ? ',sha256' : ''}`;
  const conflict = `organization_id,app_id,${scope.endUserSub === null ? '' : 'end_user_sub,'}provider_slot,credential_namespace${kind === 'asset' ? ',sha256' : ''}`;
  const result = await db.query<ReferenceRow | ReferenceAssetRow>(`INSERT INTO ${table} (${columns}) VALUES (${values.map((_,i) => `$${i+1}`).join(',')})
    ON CONFLICT (${conflict}) WHERE end_user_sub IS ${scope.endUserSub === null ? '' : 'NOT '}NULL
    DO UPDATE SET updated_at=${table}.updated_at WHERE ${table}.archived_after_move IS NULL
      AND NOT ${table}.cleanup_pending AND ${table}.deleted_at IS NULL RETURNING *`, values);
  if (!result.rows[0]) throw new Error('reference mapping unavailable (archived or deleted)');
  return result.rows[0];
}
export async function ensureReferenceGroup(db: PreparationDb, scope: AssetScope): Promise<ReferenceRow> { return ensure(db,'group',scope); }
/** Hash verified exact bytes; never use a URL or inferred provenance as identity. */
export async function ensureReferenceAsset(db: PreparationDb, scope: AssetScope, sha256: string): Promise<ReferenceAssetRow> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('sha256 must be lowercase exact-byte SHA-256');
  return ensure(db,'asset',scope,sha256) as Promise<ReferenceAssetRow>;
}
async function get(db: PreparationDb, kind: Kind, scope: AssetScope, id: string) {
  return (await db.query<ReferenceRow | ReferenceAssetRow>(`SELECT * FROM ${tableFor(kind)} WHERE ${scopeSql} AND id=$6 AND ${live}`, [...scopeValues(scope),id])).rows[0] ?? null;
}
export async function getReferenceGroup(db: PreparationDb, scope: AssetScope, id: string): Promise<ReferenceRow | null> { return get(db,'group',scope,id); }
export async function getReferenceAsset(db: PreparationDb, scope: AssetScope, id: string): Promise<ReferenceAssetRow | null> { return get(db,'asset',scope,id) as Promise<ReferenceAssetRow | null>; }
async function claim(db: PreparationDb, kind: Kind, scope: AssetScope, id: string, worker: string, leaseMs: number) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('lease duration must be positive milliseconds');
  return (await db.query<ReferenceRow | ReferenceAssetRow>(`UPDATE ${tableFor(kind)} SET fence=fence+1,
    lease_owner=$7,lease_expires_at=now()+$8*interval '1 millisecond',status=CASE WHEN status='new' THEN 'registering' ELSE status END,updated_at=now()
    WHERE ${scopeSql} AND id=$6 AND ${live} AND NOT cleanup_pending AND deleted_at IS NULL
      AND status IN ('new','pending') AND (lease_expires_at IS NULL OR lease_expires_at<=now()) RETURNING *`,
  [...scopeValues(scope),id,worker,leaseMs])).rows[0] ?? null;
}
/** new grants registration; pending grants polling only. Expired registering/uncertain NEVER grants another POST. */
export async function claimReferenceGroup(db: PreparationDb, scope: AssetScope, id: string, worker: string, leaseMs: number): Promise<ReferenceRow | null> { return claim(db,'group',scope,id,worker,leaseMs); }
export async function claimReferenceAsset(db: PreparationDb, scope: AssetScope, id: string, worker: string, leaseMs: number): Promise<ReferenceAssetRow | null> { return claim(db,'asset',scope,id,worker,leaseMs) as Promise<ReferenceAssetRow | null>; }
async function persist(db: PreparationDb, kind: Kind, scope: AssetScope, id: string, fence: number, state: ReferenceState) {
  if ((state.status === 'active' || state.status === 'pending') && !state.providerId) throw new Error('provider ID required for accepted registration');
  // Late confirmation after deletion retains the handle for cleanup. The flags
  // remain set, so the row cannot become reusable even if upstream is active.
  return (await db.query(`UPDATE ${tableFor(kind)} SET status=$8,provider_id=COALESCE($9,provider_id),diagnostic=$10,
    cleaned_at=CASE WHEN cleanup_pending THEN NULL ELSE cleaned_at END,updated_at=now()
    WHERE ${scopeSql} AND id=$6 AND fence=$7 AND ${live} AND status IN ('registering','pending','uncertain')
      AND (provider_id IS NULL OR $9::text IS NULL OR provider_id=$9)`,
  [...scopeValues(scope),id,fence,state.status,state.providerId ?? null,state.diagnostic ?? null])).rowCount === 1;
}
export async function persistReferenceGroup(db: PreparationDb, scope: AssetScope, id: string, fence: number, state: ReferenceState): Promise<boolean> { return persist(db,'group',scope,id,fence,state); }
export async function persistReferenceAsset(db: PreparationDb, scope: AssetScope, id: string, fence: number, state: ReferenceState): Promise<boolean> { return persist(db,'asset',scope,id,fence,state); }
/** Only a group in precisely the same ownership/credential scope can be linked. */
export async function attachReferenceAssetGroup(db: PreparationDb, scope: AssetScope, id: string, fence: number, groupId: string): Promise<boolean> {
  return (await db.query(`UPDATE ai_reference_assets SET group_id=$8,updated_at=now()
    WHERE ${scopeSql} AND id=$6 AND fence=$7 AND ${live} AND NOT cleanup_pending AND deleted_at IS NULL
    AND (group_id IS NULL OR group_id=$8) AND EXISTS (SELECT 1 FROM ai_reference_asset_groups WHERE ${scopeSql}
      AND id=$8 AND ${live} AND NOT cleanup_pending AND deleted_at IS NULL AND status='active')`, [...scopeValues(scope),id,fence,groupId])).rowCount === 1;
}
/**
 * Call BEFORE app cascade, preferably in its transaction. Atomically cancel
 * admission and persist cleanup. No apps FK: retain orphan rows until uncertain
 * submissions reconcile, all settlements ack, and provider cleanup completes.
 */
export async function tombstoneAppReferences(db: PreparationDb, appId: string): Promise<void> {
  await db.query(`WITH cancelled AS (
    UPDATE ai_video_preparations SET deleted_at=COALESCE(deleted_at,now()),
      status=CASE WHEN status IN ('pending','in_progress') THEN 'cancelled' ELSE status END,
      fence=fence+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE app_id=$1 AND ${live} RETURNING id
  ), assets AS (
    UPDATE ai_reference_assets SET cleanup_pending=true,deleted_at=COALESCE(deleted_at,now()),updated_at=now()
    WHERE app_id=$1 AND ${live} RETURNING id
  ) UPDATE ai_reference_asset_groups SET cleanup_pending=true,deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE app_id=$1 AND ${live}`, [appId]);
}
export interface ReferenceCleanupRow extends ReferenceRow { kind: Kind }
/** Assets precede groups; group ack waits for child cleanup. */
export async function listReferenceCleanup(db: PreparationDb, limit = 100): Promise<ReferenceCleanupRow[]> {
  return (await db.query<ReferenceCleanupRow>(`SELECT id,organization_id,app_id,end_user_sub,provider_slot,credential_namespace,provider_id,status,
    cleanup_pending,deleted_at,cleaned_at,fence,lease_owner,lease_expires_at,'asset'::text AS kind FROM ai_reference_assets WHERE cleanup_pending AND ${live}
    UNION ALL SELECT id,organization_id,app_id,end_user_sub,provider_slot,credential_namespace,provider_id,status,
    cleanup_pending,deleted_at,cleaned_at,fence,lease_owner,lease_expires_at,'group'::text AS kind FROM ai_reference_asset_groups WHERE cleanup_pending AND ${live}
    ORDER BY kind,id LIMIT $1`, [limit])).rows;
}
/** After idempotent provider DELETE. No-handle uncertain POSTs cannot be acked. */
export async function acknowledgeReferenceCleanup(db: PreparationDb, kind: Kind, id: string): Promise<boolean> {
  return (await db.query(`UPDATE ${tableFor(kind)} SET cleanup_pending=false,cleaned_at=now(),provider_id=NULL,status='deleted',updated_at=now()
    WHERE id=$1 AND cleanup_pending AND ${live} AND status NOT IN ('registering','uncertain')
    ${kind === 'group' ? `AND NOT EXISTS (SELECT 1 FROM ai_reference_assets WHERE group_id=$1 AND (cleanup_pending OR status!='deleted'))` : ''}`, [id])).rowCount === 1;
}

export interface ReferenceRecoveryRow extends ReferenceRow {
  kind: Kind;
  /** This lease grants provider lookup/reconciliation only, NEVER registration POST. */
  mode: 'reconcile_only';
  /** Original UUID remains the stable registration operation identity. */
  registration_operation_id: string;
}
const interruptedRegistration = `status IN ('registering','uncertain')
  AND (lease_expires_at IS NULL OR lease_expires_at<=now())`;

/**
 * Discover interrupted creation in all scopes, including deletion tombstones.
 * This internal scan does not grant ownership; claim a recovery lease before
 * provider lookup or persistence. Archived source-region copies stay excluded.
 */
export async function listReferenceRecovery(db: PreparationDb, limit = 100): Promise<ReferenceRecoveryRow[]> {
  const columns = `id,organization_id,app_id,end_user_sub,provider_slot,credential_namespace,provider_id,status,
    cleanup_pending,deleted_at,cleaned_at,fence,lease_owner,lease_expires_at,
    'reconcile_only'::text AS mode,id AS registration_operation_id`;
  return (await db.query<ReferenceRecoveryRow>(`SELECT ${columns},'asset'::text AS kind
    FROM ai_reference_assets WHERE ${live} AND ${interruptedRegistration}
    UNION ALL SELECT ${columns},'group'::text AS kind
    FROM ai_reference_asset_groups WHERE ${live} AND ${interruptedRegistration}
    ORDER BY kind,id LIMIT $1`, [limit])).rows;
}
async function claimRecovery(db: PreparationDb, kind: Kind, scope: AssetScope, id: string, worker: string, leaseMs: number): Promise<ReferenceRecoveryRow | null> {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('lease duration must be positive milliseconds');
  return (await db.query<ReferenceRecoveryRow>(`UPDATE ${tableFor(kind)} SET fence=fence+1,
    lease_owner=$7,lease_expires_at=now()+$8*interval '1 millisecond',status='uncertain',updated_at=now()
    WHERE ${scopeSql} AND id=$6 AND ${live} AND ${interruptedRegistration}
    RETURNING *,'${kind}'::text AS kind,'reconcile_only'::text AS mode,id AS registration_operation_id`,
  [...scopeValues(scope),id,worker,leaseMs])).rows[0] ?? null;
}
/** Reconciliation-only takeover fences the original worker; preserves tombstones and operation UUID. */
export async function claimReferenceGroupRecovery(db: PreparationDb, scope: AssetScope, id: string, worker: string, leaseMs: number): Promise<ReferenceRecoveryRow | null> {
  return claimRecovery(db,'group',scope,id,worker,leaseMs);
}
/** Reconciliation-only: a recovered uncertain state never authorizes a new registration POST. */
export async function claimReferenceAssetRecovery(db: PreparationDb, scope: AssetScope, id: string, worker: string, leaseMs: number): Promise<ReferenceRecoveryRow | null> {
  return claimRecovery(db,'asset',scope,id,worker,leaseMs);
}
