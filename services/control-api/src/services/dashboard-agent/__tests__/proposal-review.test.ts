import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureApprovalOperation } from '../approval-operation.js';
import { PreparedProposalSchema, setApprovalProposalProvider } from '../approval-proposal.js';
import { verifyPreparedApproval, buildProposalReview } from '../proposal-review.js';

const operation = captureApprovalOperation({ toolName: 'manage_substrate', args: { action: 'cancel_outbox', outbox_id: 'obx_synthetic' } });
const proposal = () => PreparedProposalSchema.parse({ version: 1, source: 'explicit', preparedAt: new Date().toISOString(), intentFingerprint: 'a'.repeat(64), operationFingerprint: 'b'.repeat(64), reason: { text: 'Obsolete draft.', attribution: 'operator' }, evidence: [], preview: { title: 'Cancel?', summary: 'Stops delivery.', target: { label: 'Synthetic', reference: 'obx_synthetic' }, effects: ['Stops delivery.'], fields: [] }, preconditions: [{ kind: 'outbox', referenceId: 'obx_synthetic', fingerprint: 'c'.repeat(64) }] });
const approval = () => ({ id: 'approval-example', status: 'pending', toolName: operation.toolName, toolArgs: operation.args, approvedOperation: operation, proposalDetails: proposal() } as any);
const context = () => ({ organizationId: 'org-example', actorUserId: 'owner-example', origin: 'operator' as const, conversationId: 'conversation-example', operation, validateRegisteredToolArguments: vi.fn(async () => ({ toolName: operation.toolName, args: operation.args as Record<string, unknown> })) });
afterEach(() => setApprovalProposalProvider(null));
describe('prepared review and execution validation', () => {
  it('requires the provider even when new writers are disabled', async () => {
    const provider = { enabled: () => false, prepare: vi.fn(), revalidate: vi.fn(async () => ({ status: 'valid' as const })) };
    setApprovalProposalProvider(provider);
    expect(await verifyPreparedApproval(context(), approval())).toEqual({ status: 'valid' });
    expect(provider.revalidate).toHaveBeenCalledOnce();
    setApprovalProposalProvider(null);
    expect(await verifyPreparedApproval(context(), approval())).toEqual({ status: 'unavailable', code: 'proposal_review_unavailable' });
  });
  it('fails before material checks when current parsed arguments no longer match', async () => {
    const revalidate = vi.fn(); setApprovalProposalProvider({ enabled: () => true, prepare: vi.fn(), revalidate });
    const ctx = context(); ctx.validateRegisteredToolArguments.mockResolvedValue({ toolName: operation.toolName, args: { action: 'cancel_outbox', outbox_id: 'obx_changed' } });
    expect(await verifyPreparedApproval(ctx, approval())).toEqual({ status: 'changed', code: 'proposal_state_changed' });
    expect(revalidate).not.toHaveBeenCalled();
  });
  it('hides stale or inaccessible facts and never enables incomplete or uncertain execution', async () => {
    const a = approval(); const ctx = context();
    setApprovalProposalProvider({ enabled: () => false, prepare: vi.fn(), revalidate: async () => ({ status: 'changed', code: 'proposal_state_changed' }) });
    const stale = await buildProposalReview(a, ctx, { approve: true, decline: true, requestReview: true });
    expect(stale).toMatchObject({ reviewStatus: 'stale', proposal: null, permittedActions: { approve: false } });
    const legacy = await buildProposalReview({ ...a, proposalDetails: null }, ctx, { approve: true, decline: true, requestReview: true });
    expect(legacy).toMatchObject({ reviewStatus: 'legacy', permittedActions: { approve: false, requestReview: true } });
    setApprovalProposalProvider({ enabled: () => false, prepare: vi.fn(), revalidate: async () => ({ status: 'valid' }) });
    const uncertain = await buildProposalReview({ ...a, executionOutcome: { version: 1, state: 'unconfirmed', attemptCount: 1, startedAt: null, finishedAt: null, safeErrorCode: 'execution_unconfirmed', resultReference: null } }, ctx, { approve: true, decline: true, requestReview: true });
    expect(uncertain.permittedActions.approve).toBe(false);
  });
});
