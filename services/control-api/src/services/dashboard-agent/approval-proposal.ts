import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ApprovedOperation } from './approval-operation.js';

/** JSONB-stable ordering; arrays and all business fields remain significant. */
export function proposalFingerprint(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])]));
    return item;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'null').digest('hex');
}

export function proposalIntentFingerprint(toolName: string, args: unknown, artifact?: ApprovedOperation['artifact']): string {
  let normalized = args;
  if (toolName === 'manage_substrate' && args && typeof args === 'object' && !Array.isArray(args) && (args as Record<string, unknown>).action === 'propose') {
    const { idempotency_key: _transportKey, ...rest } = args as Record<string, unknown>;
    normalized = rest;
  }
  return proposalFingerprint({ toolName, args: normalized, ...(artifact ? { artifact } : {}) });
}

const OpaqueId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.string().datetime();

export const EvidenceInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entity'), id: OpaqueId }).strict(),
  z.object({ kind: z.literal('artifact'), id: OpaqueId }).strict(),
  z.object({ kind: z.literal('learning'), id: OpaqueId }).strict(),
  z.object({ kind: z.literal('decision'), id: OpaqueId }).strict(),
  z.object({ kind: z.literal('commitment'), id: OpaqueId }).strict(),
  z.object({ kind: z.literal('app'), app_id: OpaqueId }).strict(),
  z.object({ kind: z.literal('file'), app_id: OpaqueId, object_id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('message'), conversation_id: z.string().uuid(), message_id: z.string().uuid() }).strict(),
]);
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;

export const ProposalInputSchema = z.object({
  operation: z.object({ tool: z.string().min(1).max(128), arguments: z.record(z.unknown()) }).strict(),
  reason: z.string().trim().min(1).max(2000),
  evidence_refs: z.array(EvidenceInputSchema).max(10).default([]),
}).strict();
export type ProposalInput = z.infer<typeof ProposalInputSchema>;

export const VerifiedEvidenceSchema = z.object({
  reference: EvidenceInputSchema,
  label: z.string().trim().min(1).max(200),
  detail: z.string().max(500).optional(),
}).strict();

const Fact = z.object({ label: z.string().min(1).max(200), value: z.string().max(4000) }).strict();
export const ProposalPreviewSchema = z.object({
  title: z.string().min(1).max(300),
  summary: z.string().min(1).max(4000),
  target: z.object({ label: z.string().min(1).max(300), reference: OpaqueId, appId: OpaqueId.optional() }).strict(),
  effects: z.array(z.string().min(1).max(2000)).min(1).max(30),
  fields: z.array(Fact).max(100),
  before: z.array(Fact).max(100).optional(),
  after: z.array(Fact).max(100).optional(),
  inputs: z.record(z.unknown()).optional(),
  code: z.object({ source: z.string().min(1).max(1_000_000), sha256: Digest, language: z.string().max(30) }).strict().optional(),
  artifact: z.object({ kind: z.enum(['storage_object', 'snapshot', 'inline_code']), referenceId: OpaqueId, sha256: Digest }).strict().optional(),
}).strict();
export type ProposalPreview = z.infer<typeof ProposalPreviewSchema>;

export const ProposalPreconditionSchema = z.object({
  kind: z.enum(['outbox', 'action', 'app', 'function', 'entity', 'principle', 'artifact', 'schema', 'storage', 'message', 'selection']),
  referenceId: OpaqueId,
  appId: OpaqueId.optional(),
  fingerprint: Digest,
}).strict();
export type ProposalPrecondition = z.infer<typeof ProposalPreconditionSchema>;

export const PreparedProposalSchema = z.object({
  version: z.literal(1),
  source: z.enum(['explicit', 'intercepted', 'substrate_escalation']),
  preparedAt: Timestamp,
  intentFingerprint: Digest,
  operationFingerprint: Digest,
  reason: z.object({ text: z.string().trim().min(1).max(2000), attribution: z.literal('operator') }).strict(),
  evidence: z.array(VerifiedEvidenceSchema).max(10),
  preview: ProposalPreviewSchema,
  preconditions: z.array(ProposalPreconditionSchema).min(1).max(200),
}).strict();
export type PreparedProposal = z.infer<typeof PreparedProposalSchema>;

export const ExecutionOutcomeSchema = z.object({
  version: z.literal(1),
  state: z.enum(['not_started', 'running', 'succeeded', 'failed', 'unconfirmed']),
  attemptCount: z.number().int().nonnegative(),
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  safeErrorCode: z.string().regex(/^[a-z0-9_]{1,100}$/).nullable(),
  resultReference: z.object({ kind: z.enum(['tool_execution', 'action', 'trace']), id: OpaqueId }).strict().nullable(),
}).strict();
export type ExecutionOutcome = z.infer<typeof ExecutionOutcomeSchema>;

export function readPreparedProposal(value: unknown): PreparedProposal | null {
  const parsed = PreparedProposalSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function readExecutionOutcome(value: unknown): ExecutionOutcome | null {
  const parsed = ExecutionOutcomeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const CREDENTIAL_FIELD = /password|passwd|secret|token|authorization|credential|private.?key|api.?key|cookie/i;
const ENVIRONMENT_FIELD = /^(env|envVars|env_vars|environment|environmentVariables)$/i;
/** Only structured argument display. This does not claim to sanitize arbitrary source. */
export function redactProposalArguments(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[unavailable]';
  if (Array.isArray(value)) return value.map(item => redactProposalArguments(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (ENVIRONMENT_FIELD.test(key)) return [key, item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, entry === null ? null : '[redacted]']))
        : '[redacted]'];
      return [key, CREDENTIAL_FIELD.test(key) ? '[redacted]' : redactProposalArguments(item, depth + 1)];
    }));
  }
  return value;
}

/** Excludes execution fingerprints/preconditions and all raw operation arguments. */
export function projectPreparedProposal(proposal: PreparedProposal) {
  return {
    version: proposal.version,
    source: proposal.source,
    preparedAt: proposal.preparedAt,
    reason: proposal.reason,
    evidence: proposal.evidence,
    preview: {
      ...proposal.preview,
      ...(proposal.preview.inputs ? { inputs: redactProposalArguments(proposal.preview.inputs) as Record<string, unknown> } : {}),
    },
  };
}

export interface ProposalContext {
  organizationId: string;
  actorUserId?: string;
  origin: 'operator' | 'office';
  conversationId: string;
  operation: ApprovedOperation;
  /** Server-owned snapshot bytes, never populated from wrapper arguments. */
  artifactSource?: string;
  artifactFiles?: Array<{ path: string; content: string; sha256: string }>;
  validateRegisteredToolArguments(name: string, args: unknown): Promise<{ toolName: string; args: Record<string, unknown> }>;
  signal?: AbortSignal;
}
export type PreparationResult =
  | { status: 'ready'; proposal: PreparedProposal }
  | { status: 'needs_input'; code: 'proposal_incomplete'; missing: string[] }
  | { status: 'blocked'; code: 'proposal_invalid' | 'proposal_unreviewable' | 'proposal_duplicate_parked_actions' | 'proposal_outbox_in_flight'; message: string };
export type ProposalVerification =
  | { status: 'valid' }
  | { status: 'changed'; code: 'proposal_state_changed' }
  | { status: 'unavailable'; code: 'proposal_review_unavailable' };
export interface ApprovalProposalProvider {
  enabled(organizationId: string): boolean;
  /** Pure action-specific parsing, shared with dispatch; never reads targets. */
  validateArguments?(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  canRead?(context: ProposalContext, saved: PreparedProposal): Promise<boolean>;
  prepare(context: ProposalContext, input: ProposalInput): Promise<PreparationResult>;
  revalidate(context: ProposalContext, saved: PreparedProposal): Promise<ProposalVerification>;
}
export interface ProposalReviewDto {
  reviewStatus: 'ready' | 'stale' | 'unavailable' | 'legacy';
  proposal: ReturnType<typeof projectPreparedProposal> | null;
  executionOutcome: ExecutionOutcome | null;
  permittedActions: { approve: boolean; decline: boolean; requestReview: boolean };
}

let provider: ApprovalProposalProvider | null = null;
export function setApprovalProposalProvider(value: ApprovalProposalProvider | null): void { provider = value; }
export function getApprovalProposalProvider(): ApprovalProposalProvider | null { return provider; }
