import { describe, expect, it } from 'vitest';
import {
  ProposalInputSchema,
  readPreparedProposal,
  readExecutionOutcome,
  projectPreparedProposal,
} from '../approval-proposal.js';

const operation = { tool: 'manage_substrate', arguments: { action: 'cancel_outbox', outbox_id: 'obx_example' } };
const prepared = () => ({
  version: 1,
  source: 'explicit',
  preparedAt: '2026-10-29T00:00:00.000Z',
  intentFingerprint: 'a'.repeat(64),
  operationFingerprint: 'b'.repeat(64),
  reason: { text: 'The draft is obsolete.', attribution: 'operator' },
  evidence: [],
  preview: { title: 'Cancel this delivery?', summary: 'Stops future attempts.', target: { label: 'Invoice email', reference: 'obx_example' }, effects: ['The original action remains in history.'], fields: [] },
  preconditions: [{ kind: 'outbox', referenceId: 'obx_example', fingerprint: 'c'.repeat(64) }],
});

describe('structured approval contract', () => {
  it('requires a bounded, explicit operator reason and structured arguments', () => {
    expect(ProposalInputSchema.parse({ operation, reason: '  Obsolete draft.  ' }).reason).toBe('Obsolete draft.');
    for (const reason of ['', '  ', 'x'.repeat(2001)]) expect(ProposalInputSchema.safeParse({ operation, reason }).success).toBe(false);
    expect(ProposalInputSchema.safeParse({ operation: { ...operation, arguments: '{}' }, reason: 'Reason' }).success).toBe(false);
  });
  it('allows no supporting records but bounds and types supplied references', () => {
    expect(ProposalInputSchema.parse({ operation, reason: 'Reason' }).evidence_refs).toEqual([]);
    const evidence_refs = Array.from({ length: 10 }, (_, i) => ({ kind: 'entity', id: `ent_example${i}` }));
    expect(ProposalInputSchema.safeParse({ operation, reason: 'Reason', evidence_refs }).success).toBe(true);
    expect(ProposalInputSchema.safeParse({ operation, reason: 'Reason', evidence_refs: [...evidence_refs, evidence_refs[0]] }).success).toBe(false);
    expect(ProposalInputSchema.safeParse({ operation, reason: 'Reason', evidence_refs: [{ kind: 'record', id: 'arbitrary-table' }] }).success).toBe(false);
  });
  it('rejects caller-authored authority and reference labels', () => {
    expect(ProposalInputSchema.safeParse({ operation, reason: 'Reason', safe: true }).success).toBe(false);
    expect(ProposalInputSchema.safeParse({ operation: { ...operation, organization_id: 'foreign' }, reason: 'Reason' }).success).toBe(false);
    expect(ProposalInputSchema.safeParse({ operation, reason: 'Reason', evidence_refs: [{ kind: 'entity', id: 'ent_example', label: 'Trust me' }] }).success).toBe(false);
  });
  it('does not turn missing, corrupt or future metadata into a review', () => {
    expect(readPreparedProposal(null)).toBeNull();
    expect(readPreparedProposal({ ...prepared(), version: 2 })).toBeNull();
    expect(readPreparedProposal({ ...prepared(), operationFingerprint: 'invalid' })).toBeNull();
    expect(readPreparedProposal(prepared())?.reason.attribution).toBe('operator');
  });
  it('projects only review fields and redacts structured credential inputs', () => {
    const input = { ...prepared(), preview: { ...prepared().preview, inputs: { customer: 'Synthetic customer', credentials: { token: 'never-display' }, nested: { api_key: 'also-private', value: 3 } } } };
    const result = projectPreparedProposal(readPreparedProposal(input)!);
    expect(JSON.stringify(result)).not.toContain('never-display');
    expect(JSON.stringify(result)).not.toContain('also-private');
    expect(JSON.stringify(result)).toContain('Synthetic customer');
    expect(result).not.toHaveProperty('preconditions');
    expect(result).not.toHaveProperty('operationFingerprint');
    expect(result).not.toHaveProperty('intentFingerprint');
  });
  it('keeps uncertain execution distinct from a confirmed result', () => {
    const outcome = { version: 1, state: 'unconfirmed', attemptCount: 1, startedAt: '2026-10-29T00:00:00.000Z', finishedAt: null, safeErrorCode: 'remote_outcome_unknown', resultReference: null };
    expect(readExecutionOutcome(outcome)?.state).toBe('unconfirmed');
    expect(readExecutionOutcome({ ...outcome, state: 'probably_succeeded' })).toBeNull();
    expect(readExecutionOutcome({ ...outcome, safeErrorCode: 'https://user:secret@example.com' })).toBeNull();
  });
});
