import type pg from 'pg';
import type { Approval } from './approvals-store.js';
import { withApprovalResolutionLock } from './approval-resolution-lock.js';
import { expireProposalAndCompleteCall } from './proposal-store.js';
import { getOrCreateOperatorConversation, operatorUserId } from './operator-store.js';
import { getApprovalProposalProvider } from './approval-proposal.js';
import { stripJsonbNulls } from './store.js';
import { resolveOperatorModel } from './operator-turn.js';

/** The owner requests preparation, never replacement arguments or execution. */
export async function requestApprovalReview(pool: pg.Pool, input: {
  approval: Approval; organizationId: string; actorUserId: string; mayRun: boolean;
}): Promise<{ ok: true; resume: 'queued' | 'waiting' } | { ok: false }> {
  return withApprovalResolutionLock(pool, input.approval, async (scoped, current) => {
    if (!current || current.status !== 'pending') return { ok: false };
    if (current.executionOutcome && ['running', 'unconfirmed'].includes(current.executionOutcome.state)) return { ok: false };
    let queued = false;
    const expired = await expireProposalAndCompleteCall(scoped, {
      approval: current, code: 'proposal_review_required', resolvedBy: input.actorUserId,
      afterExpire: async client => {
        const conversation = await client.query('SELECT user_id FROM dashboard_agent_conversations WHERE id=$1', [current.conversationId]);
        if (conversation.rows[0]?.user_id !== operatorUserId(input.organizationId)) {
          // Hand off only the org-shared frozen operation. A member's private
          // conversation is never impersonated or copied to the operator.
          const operatorConversationId = await getOrCreateOperatorConversation(client as unknown as pg.Pool, input.organizationId, resolveOperatorModel());
          const operation = current.approvedOperation ?? { toolName: current.toolName, args: current.toolArgs };
          const content = '=== PROPOSAL REVIEW REQUEST (platform-authored) ===\n' + JSON.stringify(stripJsonbNulls({ approval_id: current.id, operation, requested_by: input.actorUserId })) + '\nThe owner requested a complete proposal for this frozen operation. Verify its current target and any supporting records, explain your reason, then use propose_action. This request does not authorize execution. Do not invent intent from a sweep summary.\n=== END PROPOSAL REVIEW REQUEST ===';
          await client.query(`INSERT INTO dashboard_agent_messages(conversation_id,role,content) VALUES($1,'user',$2)`, [operatorConversationId, content]);
          await client.query('UPDATE dashboard_agent_conversations SET last_message_at=now(),updated_at=now() WHERE id=$1', [operatorConversationId]);
        }
        if (input.mayRun && getApprovalProposalProvider()?.enabled(input.organizationId)) {
          const result = await client.query(`UPDATE dashboard_agent_operator_jobs SET next_run_at=now() WHERE organization_id=$1 AND enabled=true RETURNING id`, [input.organizationId]);
          queued = !!result.rowCount;
        }
      },
    });
    return expired ? { ok: true, resume: queued ? 'queued' : 'waiting' } : { ok: false };
  });
}
