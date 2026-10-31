import type pg from 'pg';
import { captureApprovalOperation, readApprovedOperation } from './approval-operation.js';
import { getApprovalProposalProvider, ProposalExplanationSchema, ProposalInputSchema, readPreparedProposal, type ProposalContext, type ProposalExplanation } from './approval-proposal.js';
import { validateProposalToolArguments } from './proposal-validation.js';
import type { ReviewPreparation } from './review-preparation-store.js';

/** Adds display context only: never queues work, prepares a proposal, or authorizes execution. */
export async function explainReviewPreparations(pool: Pick<pg.Pool, 'query'>, organizationId: string, actorUserId: string, requests: ReviewPreparation[]): Promise<ReviewPreparation[]> {
  const provider = getApprovalProposalProvider();
  if (!provider || !requests.length) return requests;
  const { rows } = await pool.query(`SELECT a.id,a.conversation_id,a.tool_name,a.tool_args,a.approved_operation,a.proposal_details,
      CASE WHEN c.user_id='operator:' || $1 THEN 'operator' ELSE 'office' END AS source,
      m.tool_name AS input_tool_name,m.tool_args AS input_args
    FROM dashboard_agent_approvals a JOIN dashboard_agent_conversations c ON c.id=a.conversation_id
    LEFT JOIN dashboard_agent_messages m ON m.id=a.turn_message_id AND m.conversation_id=a.conversation_id AND m.role='assistant'
    WHERE c.organization_id=$1 AND a.id=ANY($2::uuid[])
      AND (c.origin='office' OR c.user_id='operator:' || $1)`, [organizationId, requests.map(row => row.approvalId)]);
  const records = new Map(rows.map(row => [row.id, row]));
  const result: ReviewPreparation[] = [];
  // Bounded fanout; a missing/private/failed target affects only its own description.
  for (let offset = 0; offset < requests.length; offset += 4) {
    result.push(...await Promise.all(requests.slice(offset, offset + 4).map(async request => {
      const row = records.get(request.approvalId);
      if (!row) return request;
      const context: ProposalContext = { organizationId, actorUserId, origin: row.source,
        conversationId: row.conversation_id,
        operation: readApprovedOperation(row.approved_operation) ?? captureApprovalOperation({ toolName: row.tool_name, args: row.tool_args }),
        validateRegisteredToolArguments: validateProposalToolArguments };
      let saved: ProposalExplanation | undefined;
      const proposal = readPreparedProposal(row.proposal_details);
      try {
        if (proposal && await provider.canRead?.(context, proposal)) {
          const { title, summary, effects, fields } = proposal.preview;
          saved = { title, summary, effects, fields, reason: proposal.reason, evidence: proposal.evidence,
            facts: { source: 'prepared', at: proposal.preparedAt } };
        }
      } catch { /* Historical metadata must remain private when visibility cannot be verified. */ }
      let current: ProposalExplanation | null = null;
      try {
        const parsed = row.input_tool_name === 'propose_action' ? ProposalInputSchema.safeParse(row.input_args) : null;
        current = await provider.explain?.(context, parsed?.success ? parsed.data : undefined) ?? null;
      } catch { /* Never expose raw lookup/provider errors or lose the other requests. */ }
      const explanation = current ? { ...current, reason: current.reason ?? saved?.reason ?? null,
        evidence: current.evidence.length ? current.evidence : saved?.evidence ?? [] } : saved;
      const checked = ProposalExplanationSchema.safeParse(explanation);
      return checked.success ? { ...request, explanation: checked.data } : request;
    })));
  }
  return result;
}
