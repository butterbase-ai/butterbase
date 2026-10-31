import { z } from 'zod';
import { officeRecordAgentMemorySchema, officeAmendAgentMemorySchema, officeArchiveAgentMemorySchema } from './office-agent-memory.js';
export * from './office-agent-memory.js';
export * from './office-skills.js';

/** Public organization-scoped Office protocol. No app or browser session is implied. */
export const OFFICE_ACTIONS = [
  'status', 'enable', 'pause', 'resume', 'list_decisions', 'get_decision',
  'get_decision_context', 'approve', 'deny', 'create_conversation', 'list_conversations',
  'get_conversation', 'ask', 'list_memory', 'search_memory', 'get_source_artifact',
  'record_decision', 'record_commitment', 'record_learning', 'list_principles',
  'get_principle', 'record_principle',
  'list_agent_memories', 'search_agent_memories', 'get_agent_memory',
  'record_agent_memory', 'amend_agent_memory', 'archive_agent_memory',
  'list_skills', 'get_skill', 'list_skill_versions', 'list_skill_runs', 'draft_skill',
  'test_skill', 'reject_skill', 'approve_skill', 'set_skill_enabled', 'rollback_skill', 'run_skill',
  'amend_principle', 'retire_principle',
  'get_office_settings', 'update_office_settings',
] as const;
export type OfficeAction = typeof OFFICE_ACTIONS[number];

const id = z.string().trim().min(1).max(256);
const text = z.string().trim().min(1);
const timestamp = z.string().datetime();
const json = z.record(z.unknown());
const salience = z.enum(['ambient', 'normal', 'archival']);
const org = { org_id: z.string().uuid() };
const keyed = { idempotency_key: id };
const page = { cursor: z.string().trim().min(1).max(2048).optional(), limit: z.number().int().min(1).max(100).optional() };
const decision = { decision_id: id, decision_source: z.enum(['office', 'substrate']).default('office') };
export const decisionRefSchema = z.object({ source: z.enum(['office', 'substrate']), id }).strict();
export type DecisionRef = z.infer<typeof decisionRefSchema>;
export const officeAmendPrincipleSchema = z.object({ principle_id: id, reason: text.max(4000), title: text.max(500).optional(),
  rationale: z.string().max(16000).optional(), applies_to: json.optional(), constraint_spec: json.optional(), salience: salience.optional() }).strict()
  .refine(p => Object.keys(p).some(key => !['principle_id', 'reason'].includes(key)), 'No changes supplied');
export const officeRetirePrincipleSchema = z.object({ principle_id: id, reason: text.max(4000) }).strict();
export type OfficeAmendPrincipleInput = z.infer<typeof officeAmendPrincipleSchema>;
export type OfficeRetirePrincipleInput = z.infer<typeof officeRetirePrincipleSchema>;
export const officeIntervalSchema = z.union([z.literal(10), z.literal(15), z.literal(30), z.literal(60)]);
export interface OfficeRoutineSettings {
  interval_minutes: 10 | 15 | 30 | 60; revision: number;
  next_routine_check_at?: string | null; full_sweep_due_at?: string | null;
  last_full_sweep_at?: string | null; blocked_reason?: string | null; reconciliation_late?: boolean;
}

/** Saved browser commands have exact action-specific fields. */
export const officeCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable') }).strict(),
  z.object({ action: z.literal('pause') }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
  z.object({ action: z.literal('approve'), decision: decisionRefSchema }).strict(),
  z.object({ action: z.literal('skill_approve'), skill_id: z.string().uuid(), version: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('skill_set_enabled'), skill_id: z.string().uuid(), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('skill_rollback'), skill_id: z.string().uuid(), version: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('skill_run_now'), skill_id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('settings_update'), interval_minutes: officeIntervalSchema, expected_revision: z.number().int().positive() }).strict(),
]);
export type OfficeCommand = z.infer<typeof officeCommandSchema> & {
  decision?: DecisionRef; skill_id?: string; version?: number; enabled?: boolean;
  interval_minutes?: 10 | 15 | 30 | 60; expected_revision?: number;
};

// Mirror the four native capability payloads; strictness prevents silent scope or policy injection.
export const officeRecordDecisionSchema = z.object({
  title: text, rationale: z.string().optional(),
  kind: z.enum(['operational', 'strategic', 'mission', 'vision', 'principle', 'policy_decision']),
  salience: salience.default('normal'), source_artifact_id: id.optional(),
}).strict();
export const officeRecordCommitmentSchema = z.object({
  description: text, from_entity: id.optional(), to_entity: id.optional(),
  amount: z.number().finite().optional(), unit: z.string().optional(), due_at: z.string().optional(),
  status: z.enum(['proposed', 'tentative', 'confirmed', 'fulfilled', 'expired', 'broken']),
  source_artifact_id: id.optional(), attrs: json.optional(),
}).strict();
export const officeRecordLearningSchema = z.object({
  title: text, description: text, resolution_taken: z.string().optional(),
  related_decision_id: id.optional(), source_artifact_id: id.optional(),
}).strict();
export const officeRecordPrincipleSchema = z.object({
  title: text, rationale: z.string().optional(), applies_to: json, constraint_spec: json,
  salience: salience.default('ambient'),
}).strict();
export type OfficeRecordDecisionInput = z.input<typeof officeRecordDecisionSchema>;
export type OfficeRecordCommitmentInput = z.input<typeof officeRecordCommitmentSchema>;
export type OfficeRecordLearningInput = z.input<typeof officeRecordLearningSchema>;
export type OfficeRecordPrincipleInput = z.input<typeof officeRecordPrincipleSchema>;
export const officeMemorySchemas = {
  record_decision: officeRecordDecisionSchema, record_commitment: officeRecordCommitmentSchema,
  record_learning: officeRecordLearningSchema, record_principle: officeRecordPrincipleSchema,
} as const;
export type OfficeMemoryKind = keyof typeof officeMemorySchemas;

export const officeActionSchema = z.discriminatedUnion('action', [
  z.object({ ...org, action: z.literal('get_office_settings') }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('update_office_settings'), interval_minutes: officeIntervalSchema, expected_revision: z.number().int().positive() }).strict(),
  z.object({ ...org, ...page, action: z.literal('list_agent_memories') }).strict(),
  z.object({ ...org, ...page, action: z.literal('search_agent_memories'), query: text.max(4000) }).strict(),
  z.object({ ...org, action: z.literal('get_agent_memory'), memory_id: id }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('record_agent_memory'), payload: officeRecordAgentMemorySchema }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('amend_agent_memory'), payload: officeAmendAgentMemorySchema }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('archive_agent_memory'), payload: officeArchiveAgentMemorySchema }).strict(),
  z.object({ ...org, action: z.literal('status'), confirmation_id: id.optional() }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('enable') }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('pause') }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('resume') }).strict(),
  z.object({ ...org, ...page, action: z.literal('list_decisions'), status: z.enum(['pending', 'resolved', 'all']).default('pending') }).strict(),
  z.object({ ...org, ...decision, action: z.literal('get_decision') }).strict(),
  z.object({ ...org, ...decision, action: z.literal('get_decision_context'), limit: page.limit }).strict(),
  z.object({ ...org, ...decision, ...keyed, action: z.literal('approve') }).strict(),
  z.object({ ...org, ...decision, action: z.literal('deny'), reason: text.max(4000) }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('create_conversation'), title: text.max(200).optional() }).strict(),
  z.object({ ...org, ...page, action: z.literal('list_conversations') }).strict(),
  z.object({ ...org, action: z.literal('get_conversation'), conversation_id: id,
    turn_id: id.optional(), after_sequence: z.number().int().nonnegative().optional(), limit: page.limit }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('ask'), message: text.max(100_000),
    conversation_id: id.optional(), wait_ms: z.number().int().min(0).max(25_000).default(15_000) }).strict(),
  z.object({ ...org, ...page, action: z.literal('list_memory'), kind: z.enum(['decision', 'commitment', 'learning']).optional() }).strict(),
  z.object({ ...org, ...page, action: z.literal('list_skills') }).strict(),
  z.object({ ...org, action: z.literal('get_skill'), skill_id: z.string().uuid() }).strict(),
  z.object({ ...org, ...page, action: z.literal('list_skill_versions'), skill_id: z.string().uuid() }).strict(),
  z.object({ ...org, ...page, action: z.literal('list_skill_runs'), skill_id: z.string().uuid() }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('draft_skill'), message: text.max(8000), skill_id: z.string().uuid().optional() }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('test_skill'), skill_id: z.string().uuid(), version: z.number().int().positive() }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('reject_skill'), skill_id: z.string().uuid(), version: z.number().int().positive(), reason: text.max(4000) }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('approve_skill'), skill_id: z.string().uuid(), version: z.number().int().positive() }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('set_skill_enabled'), skill_id: z.string().uuid(), enabled: z.boolean() }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('rollback_skill'), skill_id: z.string().uuid(), version: z.number().int().positive() }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('run_skill'), skill_id: z.string().uuid() }).strict(),
  z.object({ ...org, action: z.literal('search_memory'), query: text.max(4000), limit: page.limit }).strict(),
  z.object({ ...org, action: z.literal('get_source_artifact'), source_artifact_id: id }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('record_decision'), payload: officeRecordDecisionSchema }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('record_commitment'), payload: officeRecordCommitmentSchema }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('record_learning'), payload: officeRecordLearningSchema }).strict(),
  z.object({ ...org, ...page, action: z.literal('list_principles') }).strict(),
  z.object({ ...org, action: z.literal('get_principle'), principle_id: id }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('record_principle'), payload: officeRecordPrincipleSchema }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('amend_principle'), payload: officeAmendPrincipleSchema }).strict(),
  z.object({ ...org, ...keyed, action: z.literal('retire_principle'), payload: officeRetirePrincipleSchema }).strict(),
]).superRefine((request, ctx) => {
  if (request.action === 'get_conversation' && request.after_sequence !== undefined && !request.turn_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['turn_id'], message: 'turn_id is required with after_sequence' });
  }
});
export type OfficeActionRequest = z.infer<typeof officeActionSchema>;

export const OFFICE_ERROR_CODES = [
  'invalid_request', 'unauthenticated', 'forbidden', 'not_found', 'owner_required',
  'managed_credential_forbidden', 'credential_revoked', 'organization_scope_required',
  'paid_plan_required', 'account_suspended', 'credits_required', 'paused_by_owner',
  'credential_repair_required', 'service_unavailable', 'office_not_enabled',
  'idempotency_conflict', 'conversation_busy', 'conversation_awaiting_approval',
  'conversation_not_client_owned',
  'revision_conflict', 'agent_memory_limit_reached', 'memory_archived',
  'confirmation_expired', 'confirmation_changed', 'confirmation_unreviewable',
  'policy_conflict_requires_resolution', 'events_expired', 'event_limit_exceeded',
  'turn_interrupted', 'deadline_exceeded', 'execution_failed', 'outcome_unknown',
  'observation_timeout', 'connection_error', 'protocol_error', 'aborted',
] as const;
export type OfficeErrorCode = typeof OFFICE_ERROR_CODES[number];
export const officeErrorSchema = z.object({
  code: z.enum(OFFICE_ERROR_CODES), message: z.string(), decision: decisionRefSchema.optional(),
  history: z.object({ turn_id: id, conversation_id: id,
    state: z.enum(['running', 'awaiting_approval', 'completed', 'blocked', 'failed', 'interrupted']) }).strict().optional(),
}).strict();
export type OfficeError = z.infer<typeof officeErrorSchema>;

const confirmationIdentity = { confirmation_id: id };
export const confirmationReceiptSchema = z.discriminatedUnion('state', [
  z.object({ ...confirmationIdentity, state: z.literal('awaiting_confirmation'),
    confirmation_url: z.string().url(), expires_at: timestamp }).strict(),
  z.object({ ...confirmationIdentity, state: z.literal('executing') }).strict(),
  z.object({ ...confirmationIdentity, state: z.literal('succeeded'), outcome: json }).strict(),
  z.object({ ...confirmationIdentity, state: z.literal('rejected') }).strict(),
  z.object({ ...confirmationIdentity, state: z.literal('expired') }).strict(),
  z.object({ ...confirmationIdentity, state: z.literal('failed'), error: officeErrorSchema }).strict(),
  z.object({ ...confirmationIdentity, state: z.literal('outcome_unknown'), error: officeErrorSchema }).strict(),
]);
export type ConfirmationReceipt = z.infer<typeof confirmationReceiptSchema>;
/** Human review is derived from the stored command, never the selected dashboard org. */
export interface OfficeCommandReview {
  organization: { id: string; name: string };
  receipt: ConfirmationReceipt;
  action: OfficeCommand['action'];
  title: string;
  target: string;
  consequence: string;
  details: Array<{ label: string; value: string }>;
  can_confirm: boolean;
  blocked_reason?: 'confirmation_changed' | 'confirmation_unreviewable';
}
export const officeStatusSchema = z.object({
  organization_id: z.string().uuid(), activation_state: z.enum(['not_enabled', 'enabling', 'enabled', 'failed']),
  can_enable: z.boolean(), can_approve: z.boolean(), work_allowed: z.boolean(), paused: z.boolean(),
  blocked_reason: z.enum(['paid_plan_required', 'account_suspended', 'credits_required',
    'credential_repair_required', 'service_unavailable', 'paused_by_owner']).nullable(),
  last_turn: z.object({ at: timestamp, outcome: z.string() }).strict().nullable(),
}).strict();
export type OfficeStatus = z.infer<typeof officeStatusSchema>;
export const officeStatusResultSchema = z.union([officeStatusSchema, confirmationReceiptSchema]);

const turnIdentity = { turn_id: id, conversation_id: id, output: z.string() };
export const officeTurnSchema = z.discriminatedUnion('state', [
  z.object({ ...turnIdentity, state: z.literal('running') }).strict(),
  z.object({ ...turnIdentity, state: z.literal('awaiting_approval'), decision: decisionRefSchema }).strict(),
  z.object({ ...turnIdentity, state: z.literal('completed'), resolution: z.enum(['approved', 'denied']).optional() }).strict(),
  z.object({ ...turnIdentity, state: z.literal('blocked'), error: officeErrorSchema }).strict(),
  z.object({ ...turnIdentity, state: z.literal('failed'), error: officeErrorSchema }).strict(),
  z.object({ ...turnIdentity, state: z.literal('interrupted'), error: officeErrorSchema }).strict(),
]);
export type OfficeTurn = z.infer<typeof officeTurnSchema>;
const sequence = { sequence: z.number().int().positive() };
export const officePublicEventSchema = z.discriminatedUnion('type', [
  z.object({ ...sequence, type: z.literal('started'), turn_id: id, conversation_id: id }).strict(),
  z.object({ ...sequence, type: z.literal('text_delta'), text: z.string() }).strict(),
  z.object({ ...sequence, type: z.literal('message'), text: z.string() }).strict(),
  z.object({ ...sequence, type: z.literal('approval_required'), decision: decisionRefSchema }).strict(),
  z.object({ ...sequence, type: z.literal('decision_resolved'), decision: decisionRefSchema, resolution: z.enum(['approved', 'denied']) }).strict(),
  z.object({ ...sequence, type: z.literal('blocked'), error: officeErrorSchema }).strict(),
  z.object({ ...sequence, type: z.literal('completed'), turn_id: id, conversation_id: id,
    resolution: z.enum(['approved', 'denied']).optional() }).strict(),
  z.object({ ...sequence, type: z.literal('failed'), error: officeErrorSchema }).strict(),
  z.object({ ...sequence, type: z.literal('interrupted'), error: officeErrorSchema }).strict(),
]);
export type OfficePublicEvent = z.infer<typeof officePublicEventSchema>;
export type OfficePublicEventInput = OfficePublicEvent extends infer E
  ? E extends OfficePublicEvent ? Omit<E, 'sequence'> : never : never;

export interface OfficeClientOptions {
  apiUrl: string;
  organizationId: string;
  getToken: () => string | Promise<string>;
  fetch?: typeof globalThis.fetch;
}
export interface OfficeRequestOptions { signal?: AbortSignal; }
export interface OfficeWriteOptions extends OfficeRequestOptions { idempotencyKey?: string; }
export interface OfficePageOptions extends OfficeRequestOptions { cursor?: string; limit?: number; }
export interface OfficePage<T> { items: T[]; next_cursor: string | null; }
export interface OfficeDecision {
  ref: DecisionRef;
  canonical_ref?: DecisionRef;
  status: 'pending' | 'approved' | 'denied' | 'executed' | 'failed' | 'expired';
  title: string;
  created_at: string;
  preview: Record<string, unknown>;
  outcome?: Record<string, unknown>;
}
export interface OfficeDecisionContext {
  decision: OfficeDecision;
  references: Array<{ kind: string; id: string }>;
  policy?: Record<string, unknown>;
  messages?: Array<{ role: string; content: string }>;
}
export interface OfficeConversation {
  id: string;
  organization_id: string;
  origin: 'office';
  title: string | null;
  created_at: string;
  updated_at: string;
}
export interface OfficeConversationDetail extends OfficeConversation {
  messages: Array<{ id: string; role: string; content: string; created_at: string }>;
  turn?: OfficeTurn;
  events?: OfficePublicEvent[];
}
export interface OfficeMemoryResult {
  action_id: string;
  verdict: Record<string, unknown>;
  result?: Record<string, unknown>;
  decision?: DecisionRef;
}
/** Memory readers preserve the native record payload rather than maintaining a second schema. */
export interface OfficeMemoryRecord { id: string; kind: string; [key: string]: unknown; }
export interface OfficeSourceArtifact { id: string; [key: string]: unknown; }
export interface OfficePrinciple { id: string; title: string; applies_to: Record<string, unknown>; constraint_spec: Record<string, unknown>; [key: string]: unknown; }
