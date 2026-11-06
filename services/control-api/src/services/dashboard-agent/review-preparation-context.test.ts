import { afterEach, describe, expect, it, vi } from 'vitest';
import { explainReviewPreparations } from './review-preparation-context.js';
import { setApprovalProposalProvider, proposalFingerprint, type ApprovalProposalProvider } from './approval-proposal.js';

afterEach(() => setApprovalProposalProvider(null));
const org = '00000000-0000-4000-8000-000000000001';
const operation = { version: 1, toolName: 'manage_substrate', args: { action: 'cancel_outbox', outbox_id: 'obx_original' } };
const row = () => ({ id: 'approval-one', conversation_id: 'conversation-one', tool_name: operation.toolName, tool_args: operation.args,
  approved_operation: operation, proposal_details: null, source: 'operator', input_tool_name: 'propose_action',
  input_args: { operation: { tool: operation.toolName, arguments: operation.args }, reason: 'This test email is obsolete.', evidence_refs: [] } });
const request = { approvalId: 'approval-one', state: 'failed' as const, safeErrorCode: 'proposal_not_prepared', attemptCount: 0,
  replacementApprovalId: null, createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z' };
const explanation = { title: 'Cancel the test email?', summary: 'Stop future delivery attempts.', effects: ['Stops delivery.'], fields: [], reason: null, evidence: [] };
function provider(overrides: Partial<ApprovalProposalProvider> = {}) {
  const value = { enabled: () => false, prepare: vi.fn(), revalidate: vi.fn(), explain: vi.fn(async () => explanation), ...overrides };
  setApprovalProposalProvider(value); return value;
}
describe('read-only preparation explanations', () => {
  it('uses only scoped persisted input and preserves the preparation status without writing', async () => {
    const query = vi.fn(async () => ({ rows: [row()] })); const p = provider();
    const result = await explainReviewPreparations({ query } as any, org, 'member', [request]);
    expect(result[0]).toMatchObject({ ...request, explanation });
    expect(p.explain).toHaveBeenCalledWith(expect.objectContaining({ organizationId: org, actorUserId: 'member', operation }), row().input_args);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('c.organization_id=$1'), [org, ['approval-one']]);
    expect(query.mock.calls.every(([sql]: any) => /^\s*SELECT/.test(sql))).toBe(true);
    expect(p.prepare).not.toHaveBeenCalled();
  });
  it('does not read explanations for records missing from the authorized join or absent providers', async () => {
    const query = vi.fn(async () => ({ rows: [] })); const p = provider();
    expect(await explainReviewPreparations({ query } as any, org, 'member', [request])).toEqual([request]);
    expect(p.explain).not.toHaveBeenCalled(); setApprovalProposalProvider(null);
    query.mockClear();
    expect(await explainReviewPreparations({ query } as any, org, 'member', [request])).toEqual([request]);
    expect(query).not.toHaveBeenCalled();
  });
  it('isolates failed lookups and never serializes raw arguments or provider errors', async () => {
    const query = vi.fn(async () => ({ rows: [row(), { ...row(), id: 'approval-two' }] }));
    provider({ explain: vi.fn().mockRejectedValueOnce(Error('private-provider-value')).mockResolvedValueOnce(explanation) });
    const result = await explainReviewPreparations({ query } as any, org, 'member', [request, { ...request, approvalId: 'approval-two' }]);
    expect(result[0]).toEqual(request); expect(result[1].explanation).toEqual(explanation);
    expect(JSON.stringify(result)).not.toMatch(/private-provider-value|outbox_id|input_args/);
  });
  it('keeps a readable prepared explanation when target description is unavailable', async () => {
    const record = row();
    const saved = { version: 1, source: 'explicit', preparedAt: request.createdAt, intentFingerprint: 'a'.repeat(64), operationFingerprint: proposalFingerprint(operation),
      reason: { text: 'The recorded operator explanation.', attribution: 'operator' }, evidence: [],
      preview: { ...explanation, target: { label: 'Test email', reference: 'obx_original' }, fields: [] },
      preconditions: [{ kind: 'outbox', referenceId: 'obx_original', fingerprint: 'b'.repeat(64) }] };
    delete (saved.preview as any).reason; delete (saved.preview as any).evidence;
    (record as any).proposal_details = saved;
    const query = vi.fn(async () => ({ rows: [record] }));
    provider({ canRead: async () => true, explain: async () => null });
    const explained = (await explainReviewPreparations({ query } as any, org, 'member', [request]))[0].explanation;
    expect(explained?.reason?.text).toBe('The recorded operator explanation.');
    expect(explained?.facts).toEqual({ source: 'prepared', at: request.createdAt });
    provider({ canRead: async () => false, explain: async () => null });
    expect((await explainReviewPreparations({ query } as any, org, 'member', [request]))[0].explanation).toBeUndefined();
  });
});
