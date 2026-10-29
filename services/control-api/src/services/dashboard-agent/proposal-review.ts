import type { Approval } from './approvals-store.js';
import { verifyApprovalOperation } from './approval-operation.js';
import { getApprovalProposalProvider, projectPreparedProposal, readExecutionOutcome, type ProposalContext, type ProposalVerification, type ProposalReviewDto } from './approval-proposal.js';
import { validateLocalOperation } from './proposal-validation.js';

/** Writers can be off while compatibility readers and resolvers remain on. */
export async function verifyPreparedApproval(context: ProposalContext, approval: Approval): Promise<ProposalVerification> {
  const provider = getApprovalProposalProvider();
  if (!provider) return { status: 'unavailable', code: 'proposal_review_unavailable' };
  if (!approval.proposalDetails || !approval.approvedOperation) return { status: 'changed', code: 'proposal_state_changed' };
  try {
    const local = validateLocalOperation(approval.toolName, approval.toolArgs, new Set(['deploy_frontend', 'deploy_function_from_workspace']));
    const parsed = local ?? await context.validateRegisteredToolArguments(approval.toolName, approval.toolArgs);
    const args = provider.validateArguments ? await provider.validateArguments(parsed.toolName, parsed.args) : parsed.args;
    verifyApprovalOperation(approval.approvedOperation, { ...context.operation, toolName: parsed.toolName, args });
  } catch { return { status: 'changed', code: 'proposal_state_changed' }; }
  try { return await provider.revalidate(context, approval.proposalDetails); }
  catch { return { status: 'unavailable', code: 'proposal_review_unavailable' }; }
}

export async function buildProposalReview(approval: Approval, context: ProposalContext, permitted: ProposalReviewDto['permittedActions']): Promise<ProposalReviewDto> {
  const pending = approval.status === 'pending';
  const executionOutcome = readExecutionOutcome(approval.executionOutcome);
  const base = { executionOutcome, permittedActions: { approve: false, decline: pending && permitted.decline, requestReview: pending && permitted.requestReview } };
  if (!approval.proposalDetails || !approval.approvedOperation) return { ...base, reviewStatus: 'legacy', proposal: null };
  const provider = getApprovalProposalProvider();
  let readable = false;
  try { readable = await provider?.canRead?.(context, approval.proposalDetails) ?? false; } catch { /* hide private metadata */ }
  if (readable && executionOutcome?.state === 'succeeded') return { ...base, reviewStatus: 'ready', proposal: projectPreparedProposal(approval.proposalDetails), permittedActions: { approve: pending && permitted.approve, decline: false, requestReview: false } };
  const verification = await verifyPreparedApproval(context, approval);
  if (verification.status !== 'valid') return { ...base, reviewStatus: verification.status === 'changed' ? 'stale' : 'unavailable', proposal: readable ? projectPreparedProposal(approval.proposalDetails) : null };
  const uncertain = executionOutcome?.state === 'unconfirmed' || executionOutcome?.state === 'running';
  return {
    ...base, reviewStatus: 'ready', proposal: projectPreparedProposal(approval.proposalDetails),
    permittedActions: { approve: pending && permitted.approve && !uncertain, decline: base.permittedActions.decline, requestReview: false },
  };
}
