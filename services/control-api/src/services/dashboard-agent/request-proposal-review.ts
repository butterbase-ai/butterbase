import type pg from 'pg';
import { readSubstrateEscalationActionId, type Approval } from './approvals-store.js';
import { withApprovalResolutionLock } from './approval-resolution-lock.js';
import { expireProposalAndCompleteCall } from './proposal-store.js';
import { getOrCreateOperatorConversation, operatorUserId } from './operator-store.js';
import { getApprovalProposalProvider, ProposalInputSchema, proposalIntentFingerprint } from './approval-proposal.js';
import { getMessageByPendingApprovalId, getMessageById } from './store.js';
import { captureApprovalOperation } from './approval-operation.js';
import { validateProposalToolArguments } from './proposal-validation.js';
import { resolveOperatorModel } from './operator-turn.js';
import { readConfirmedExecution, hasUnconfirmedExecution } from './execution-outcome.js';

/** The owner requests preparation, never replacement arguments or execution. */
export async function requestApprovalReview(pool: pg.Pool, input: {
  approval: Approval; organizationId: string; actorUserId: string; mayRun: boolean;
}): Promise<{ ok: true; resume: 'queued' | 'waiting' } | { ok: false }> {
  return withApprovalResolutionLock(pool, input.approval, async (scoped, current) => {
    if (!current || (current.status !== 'pending' && !(current.status === 'expired' && current.denyReason === 'proposal_review_required'))) return { ok: false };
    if (await readConfirmedExecution(scoped, current) || current.executionOutcome?.state === 'succeeded') return { ok: false };
    if (await hasUnconfirmedExecution(scoped, current.id)) return { ok: false };
    if (current.executionOutcome && ['running', 'unconfirmed'].includes(current.executionOutcome.state)) return { ok: false };
    let operation = current.approvedOperation ?? captureApprovalOperation({ toolName: current.toolName, args: current.toolArgs });
    let parkedProposal: { actionId: string; intentFingerprint: string } | null = null;
    const actionId = readSubstrateEscalationActionId(current);
    const paused = actionId ? await getMessageByPendingApprovalId(scoped, current.id) ?? await getMessageById(scoped, current.conversationId, current.turnMessageId) : null;
    if (actionId) {
      // Recover only the server-bound parked action and original model intent.
      // A model-facing wrapper must never be told to supply an approve call.
      let intent = paused ? { tool: paused.toolName, arguments: paused.toolArgs } : null;
      if (paused?.toolName === 'propose_action') {
        const parsed = ProposalInputSchema.safeParse(paused.toolArgs);
        intent = parsed.success ? parsed.data.operation : null;
      }
      if (intent?.tool !== 'manage_substrate' || (intent.arguments as any)?.action !== 'propose') return { ok: false };
      try {
        const parsed = await validateProposalToolArguments(intent.tool, intent.arguments);
        const provider = getApprovalProposalProvider();
        const args = provider?.validateArguments ? await provider.validateArguments(parsed.toolName, parsed.args) : parsed.args;
        operation = captureApprovalOperation({ toolName: parsed.toolName, args });
        parkedProposal = { actionId, intentFingerprint: proposalIntentFingerprint(parsed.toolName, args) };
      } catch { return { ok: false }; }
    }
    let queued = false;
    const save = async (client: pg.PoolClient) => {
      if (parkedProposal && paused?.toolCallId) await client.query(
        `UPDATE dashboard_agent_messages SET tool_result=tool_result || $3::jsonb
         WHERE conversation_id=$1 AND role='tool' AND tool_call_id=$2`,
        [current.conversationId,paused.toolCallId,JSON.stringify({ parkedProposal })],
      );
      const conversation = await client.query('SELECT user_id FROM dashboard_agent_conversations WHERE id=$1', [current.conversationId]);
      const operatorConversationId = conversation.rows[0]?.user_id === operatorUserId(input.organizationId)
        ? current.conversationId : await getOrCreateOperatorConversation(client as unknown as pg.Pool, input.organizationId, resolveOperatorModel());
      await client.query(`INSERT INTO dashboard_agent_review_preparations
        (approval_id,organization_id,conversation_id,requested_by,operation,intent_fingerprint)
        VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(approval_id) DO UPDATE SET state='waiting',safe_error_code=NULL,claim_token=NULL,lease_until=NULL,updated_at=now()
          WHERE dashboard_agent_review_preparations.state IN ('blocked','failed') RETURNING approval_id`,
        [current.id,input.organizationId,operatorConversationId,input.actorUserId,JSON.stringify(operation),proposalIntentFingerprint(operation.toolName,operation.args,operation.artifact)]);
      // The claimed turn supplies its explicit input under the normal runner.
      // Appending here could split a concurrent assistant/tool result pair.
      if (input.mayRun && getApprovalProposalProvider()?.enabled(input.organizationId)) {
        const result = await client.query(`UPDATE dashboard_agent_operator_jobs SET next_run_at=now() WHERE organization_id=$1 AND enabled=true RETURNING id`, [input.organizationId]);
        queued = !!result.rowCount;
      }
    };
    let expired = true;
    if (current.status === 'pending') expired = await expireProposalAndCompleteCall(scoped, {
      approval: current, code: 'proposal_review_required', resolvedBy: input.actorUserId, afterExpire: save,
    });
    else {
      const client = await scoped.connect();
      try { await client.query('BEGIN'); await save(client); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    return expired ? { ok: true, resume: queued ? 'queued' : 'waiting' } : { ok: false };
  });
}
