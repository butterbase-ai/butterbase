// Substrate access from the browser. All calls route through the substrate-proxy
// backend function, which holds the substrate identity (ctx.substrate) — the
// browser never sees a bb_sub_ key.
//
// Probed API constraints (2026-06-10):
//  - /entities accepts only { type, q, limit }. order_by/offset/cursor/attrs.*
//    are silently ignored. Default sort = updated_at DESC.
//  - /actions accepts { capability, status, before, limit }. entity_id/from/to
//    are silently ignored — paginate with `before` and filter client-side.
//  - update_entity REPLACES attrs wholesale. Use updateEntityMerge() for
//    partial updates.
//  - No delete_entity. Use revertAction(originalUpsertActionId).

import { bbInvoke } from '@/lib/butterbase';

export type SubstrateEntityType =
  | 'person' | 'company' | 'fund' | 'workspace' | 'team'
  | 'project' | 'event' | 'agent' | 'self';

export interface SubstrateEntity {
  id: string;
  substrate_user_id: string;
  type: SubstrateEntityType;
  display_name: string | null;
  primary_email: string | null;
  canonical_keys: Record<string, unknown> | null;
  linked_app_user_id: string | null;
  linked_app_id: string | null;
  attrs: Record<string, any>;
  created_at: string;
  updated_at: string;
  created_by_entity_id: string | null;
  created_by_kind: 'human' | 'agent' | null;
  /** Present when returned from a `q` fuzzy match — trigram similarity. */
  _sim?: number;
}

export interface SubstrateAction {
  id: string;
  capability: string;
  status: 'pending' | 'executed' | 'rejected' | 'reverted';
  source_app_id: string | null;
  source_rule_id: string | null;
  proposed_at: string;
  decided_at: string | null;
  executed_at: string | null;
  payload: Record<string, any>;
  result: Record<string, any> | null;
  reversible: boolean;
  reverted_by_action_id: string | null;
  verdict: string;
  requires_approval_reason: string | null;
  proposed_by_kind: 'human' | 'agent' | null;
  proposed_by_entity_id: string | null;
  trigger_context: Record<string, unknown> | null;
  links: Array<{ entity_id: string; kind: string }> | null;
  created_at: string;
  updated_at: string;
}

export interface ProposeVerdict {
  action_id: string;
  verdict: { result: 'auto_approved' | 'auto_approved_yolo' | 'requires_approval' | 'rejected'; reason: string };
  requires_approval: boolean;
  result?: any;
}

async function call<T>(op: string, args: Record<string, any> = {}): Promise<T> {
  const { data, error } = await bbInvoke<T>('substrate-proxy', { op, ...args });
  if (error) throw error;
  if (data == null) throw new Error(`substrate-proxy ${op}: empty response`);
  return data;
}

/** List entities by type. Returns up to `limit` rows sorted by updated_at DESC. */
export async function listEntities(
  type: SubstrateEntityType,
  opts: { q?: string; limit?: number } = {},
): Promise<SubstrateEntity[]> {
  const res = await call<{ entities: SubstrateEntity[] }>('list_entities', { type, ...opts });
  return res.entities ?? [];
}

/** Fetch one entity by id. */
export async function getEntity(id: string): Promise<SubstrateEntity | null> {
  try {
    const res = await call<{ entity: SubstrateEntity }>('get_entity', { id });
    return res.entity ?? null;
  } catch (e: any) {
    if (String(e?.message ?? e).includes('not_found')) return null;
    throw e;
  }
}

/** List actions, descending by proposed_at. Cursor via `before`. */
export async function listActions(opts: {
  capability?: string;
  status?: SubstrateAction['status'];
  before?: string;
  limit?: number;
} = {}): Promise<{ actions: SubstrateAction[]; next_before: string | null }> {
  return await call<{ actions: SubstrateAction[]; next_before: string | null }>('list_actions', opts);
}

/** Propose any capability. Returns the verdict + (for auto-approved) the result. */
export async function propose(
  capability: string,
  payload: Record<string, any>,
  opts: { idempotency_key?: string } = {},
): Promise<ProposeVerdict> {
  return await call<ProposeVerdict>('propose', { capability, payload, ...opts });
}

/** Convenience: revert a prior action (typically the upsert_entity that created an entity). */
export async function revertAction(action_id: string): Promise<ProposeVerdict> {
  return await call<ProposeVerdict>('revert_action', { action_id });
}

/**
 * Partial update of an entity's attrs. The substrate's update_entity replaces
 * attrs wholesale, so we read-modify-write. Caller-supplied null/undefined
 * values in `patch` delete those keys from the merged attrs.
 *
 * Race window: between read and write a concurrent writer can clobber. For
 * single-writer UI flows this is fine. For multi-writer flows (UI + agent
 * enrichment) prefer a backend function that batches all writes in one propose.
 */
export async function updateEntityMerge(
  id: string,
  attrPatch: Record<string, any>,
  opts: { display_name?: string } = {},
): Promise<ProposeVerdict> {
  const current = await getEntity(id);
  if (!current) throw new Error(`updateEntityMerge: entity ${id} not found`);
  const merged = { ...(current.attrs ?? {}) };
  for (const [k, v] of Object.entries(attrPatch)) {
    if (v === undefined || v === null) delete merged[k];
    else merged[k] = v;
  }
  return await propose('update_entity', {
    id,
    attrs: merged,
    ...(opts.display_name ? { display_name: opts.display_name } : {}),
  });
}

// ----- domain mappers -----
//
// Translate substrate rows into the legacy types the UI expects, so individual
// components don't need to know about the substrate shape change. As we migrate
// each surface, mappers can be inlined and removed.

import type { Company, Person, Deal, Meeting, DealStage } from '@/lib/types';

/** Map a substrate company entity → the legacy Company row shape. */
export function entityToCompany(e: SubstrateEntity): Company {
  const a = e.attrs ?? {};
  return {
    id: e.id,
    workspace_id: '',
    name: e.display_name ?? a.name ?? a.domain ?? 'Unnamed company',
    domain: a.domain ?? null,
    logo_object_id: a.logo_object_id ?? null,
    industry: a.industry ?? null,
    employee_count: a.employee_count ?? null,
    location: a.location ?? null,
    description: a.description ?? null,
    linkedin_url: a.linkedin_url ?? null,
    enrichment_status: a.enrichment_status ?? null,
    enriched_at: a.enriched_at ?? null,
    ai_summary: a.ai_summary ?? null,
    ai_summary_at: a.ai_summary_at ?? null,
    substrate_entity_id: e.id,
    created_by: e.created_by_entity_id ?? '',
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}

/** Map a substrate person entity → the legacy Person row shape. */
export function entityToPerson(e: SubstrateEntity): Person {
  const a = e.attrs ?? {};
  const first_name = a.first_name ?? null;
  const last_name = a.last_name ?? null;
  return {
    id: e.id,
    workspace_id: '',
    company_id: a.company_id ?? null,
    first_name,
    last_name,
    email: a.email ?? e.primary_email ?? null,
    email_status: (a.email_status as string | undefined) ?? null,
    phone: a.phone ?? null,
    title: a.title ?? null,
    avatar_object_id: a.avatar_object_id ?? null,
    linkedin_url: a.linkedin_url ?? null,
    enrichment_status: a.enrichment_status ?? null,
    enriched_at: a.enriched_at ?? null,
    substrate_entity_id: e.id,
    is_role_account: a.is_role_account === true,
    created_by: e.created_by_entity_id ?? '',
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}

/** Map a substrate project entity (kind='deal') → the legacy Deal row shape. */
export function entityToDeal(e: SubstrateEntity): Deal {
  const a = e.attrs ?? {};
  return {
    id: e.id,
    workspace_id: a.workspace_id ?? '',
    name: e.display_name ?? a.name ?? 'Untitled deal',
    company_id: a.company_id ?? null,
    primary_person_id: a.primary_person_id ?? null,
    stage: (a.stage as DealStage) ?? 'lead',
    amount_cents: a.amount_cents ?? null,
    currency: a.currency ?? 'USD',
    close_date: a.close_date ?? null,
    owner_user_id: a.owner_user_id ?? '',
    created_by: e.created_by_entity_id ?? '',
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}

/** Map a substrate event entity (kind='meeting') → the legacy Meeting row shape. */
export function entityToMeeting(e: SubstrateEntity): Meeting {
  const a = e.attrs ?? {};
  return {
    id: e.id,
    workspace_id: a.workspace_id ?? '',
    title: e.display_name ?? a.title ?? 'Untitled meeting',
    starts_at: a.starts_at ?? e.created_at,
    ends_at: a.ends_at ?? null,
    location: a.location ?? null,
    notes: a.notes ?? null,
    company_id: a.company_id ?? null,
    deal_id: a.deal_id ?? null,
    created_by: e.created_by_entity_id ?? '',
    created_at: e.created_at,
    updated_at: e.updated_at,
    ai_summary: a.ai_summary ?? null,
    ai_summary_at: a.ai_summary_at ?? null,
    ai_action_items: a.ai_action_items ?? null,
    ai_briefing: a.ai_briefing ?? null,
    ai_briefing_at: a.ai_briefing_at ?? null,
  };
}

// ----- write-path helpers -----
//
// Substrate's upsert_entity does not dedup by attrs.* — that's our job. These
// helpers fetch-and-scan client-side. Cheap up to ~hundreds of rows; revisit if
// the org outgrows that.

/** Find a company entity matching attrs.domain (case-insensitive). null if none. */
export async function findCompanyByDomain(domain: string): Promise<SubstrateEntity | null> {
  if (!domain) return null;
  const needle = domain.toLowerCase().trim();
  const all = await listEntities('company', { limit: 200 });
  return all.find(e => String(e.attrs?.domain ?? '').toLowerCase().trim() === needle) ?? null;
}

/** Find a person entity matching attrs.email (case-insensitive). null if none. */
export async function findPersonByEmail(email: string): Promise<SubstrateEntity | null> {
  if (!email) return null;
  const needle = email.toLowerCase().trim();
  const all = await listEntities('person', { limit: 200 });
  return all.find(e => {
    const v = e.attrs?.email ?? e.primary_email ?? '';
    return String(v).toLowerCase().trim() === needle;
  }) ?? null;
}

/**
 * Create a note as a substrate action (record_learning). No dedup — every call
 * appends one ledger row. Filter the activity feed by context.entity_id.
 */
export async function proposeNote(input: {
  entity_type: 'company' | 'person' | 'deal' | 'meeting';
  entity_id: string;
  body: string;
}): Promise<ProposeVerdict> {
  return await propose('record_learning', {
    content: input.body,
    context: { entity_type: input.entity_type, entity_id: input.entity_id },
  });
}
