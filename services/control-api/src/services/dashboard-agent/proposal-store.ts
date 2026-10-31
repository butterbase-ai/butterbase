import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createApproval, type Approval } from './approvals-store.js';
import type { ApprovedOperation } from './approval-operation.js';
import { PreparedProposalSchema, type PreparedProposal } from './approval-proposal.js';
import { lockReviewPreparation, linkReviewPreparation, type ReviewPreparationClaim } from './review-preparation-store.js';

/** Only server-authored completion results in this authorized conversation count. */
export async function findParkedProposalIntent(pool: pg.Pool, organizationId: string, conversationId: string, fingerprint: string): Promise<string | null> {
  const { rows } = await pool.query<{ action_id: string }>(
    `SELECT DISTINCT action_id FROM (
     SELECT m.tool_result->'parkedProposal'->>'actionId' AS action_id
       FROM dashboard_agent_messages m JOIN dashboard_agent_conversations c ON c.id=m.conversation_id
      WHERE c.id=$1 AND c.organization_id=$2
        AND ((m.role='tool' AND m.tool_name='manage_substrate')
          OR (m.role='user' AND m.tool_name='proposal_review_handoff'))
        AND m.tool_args->>'action'='propose'
        AND m.tool_result->>'code' IN ('proposal_incomplete','proposal_review_required')
        AND m.tool_result->'parkedProposal'->>'intentFingerprint'=$3
     UNION ALL
     SELECT result.tool_result->'parkedProposal'->>'actionId' AS action_id
       FROM dashboard_agent_review_preparations p
       JOIN dashboard_agent_approvals a ON a.id=p.approval_id
       JOIN dashboard_agent_conversations c ON c.id=a.conversation_id
       JOIN dashboard_agent_messages paused ON paused.id=a.turn_message_id AND paused.conversation_id=c.id
       JOIN dashboard_agent_messages result ON result.conversation_id=c.id
         AND result.role='tool' AND result.tool_call_id=paused.tool_call_id
      WHERE p.conversation_id=$1 AND p.organization_id=$2 AND c.organization_id=$2
        AND p.intent_fingerprint=$3 AND p.operation->>'toolName'='manage_substrate'
        AND p.operation->'args'->>'action'='propose'
        AND result.tool_result->>'code'='proposal_review_required'
        AND result.tool_result->'parkedProposal'->>'intentFingerprint'=$3
     ) provenance`,
    [conversationId, organizationId, fingerprint],
  );
  const ids = rows.map(row => row.action_id).filter(id => /^act_[A-Za-z0-9]+$/.test(id));
  if (ids.length > 1) throw new Error('proposal_duplicate_parked_actions');
  return ids[0] ?? null;
}

export interface PersistPreparedApprovalInput {
  id?: string;
  organizationId: string;
  conversationId: string;
  operation: ApprovedOperation;
  proposal: PreparedProposal;
  traceId?: string | null;
  reviewPreparation?: ReviewPreparationClaim;
  message: { id: string; callId: string; toolName: string; args: unknown; content: string; model: string };
}

/** One transaction owns duplicate lookup, approval and its original paused call. */
export async function persistPreparedApproval(pool: pg.Pool, input: PersistPreparedApprovalInput): Promise<
  { kind: 'created'; approval: Approval } | { kind: 'duplicate'; approvalId: string }
> {
  const proposal = PreparedProposalSchema.parse(input.proposal);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: conversations } = await client.query(
      `SELECT id FROM dashboard_agent_conversations WHERE id=$1 AND organization_id=$2
       AND (origin='office' OR user_id='operator:' || $2) FOR SHARE`,
      [input.conversationId, input.organizationId],
    );
    if (conversations.length !== 1) throw new Error('proposal_conversation_unavailable');
    if (input.reviewPreparation) await lockReviewPreparation(client, input.reviewPreparation, input.organizationId, input.conversationId, proposal.intentFingerprint);
    // Same namespace for BOTH identities: an intent in one request can be an
    // executable identity in another. Sorted distinct keys avoid lock inversion.
    const fingerprints = [...new Set([proposal.intentFingerprint, proposal.operationFingerprint])].sort();
    for (const fingerprint of fingerprints) await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      [`office-proposal:${input.organizationId}:${fingerprint}`],
    );
    const duplicate = await client.query<{ id: string }>(
      `SELECT a.id FROM dashboard_agent_approvals a
       JOIN dashboard_agent_conversations c ON c.id=a.conversation_id
       WHERE a.status='pending' AND c.organization_id=$1
         AND (c.origin='office' OR c.user_id='operator:' || $1)
         AND (a.proposal_details->>'intentFingerprint'=ANY($2::text[])
           OR a.proposal_details->>'operationFingerprint'=ANY($2::text[]))
       ORDER BY a.created_at,a.id LIMIT 1`,
      [input.organizationId, fingerprints],
    );
    if (duplicate.rows[0]) {
      if (input.reviewPreparation) await linkReviewPreparation(client, input.reviewPreparation, duplicate.rows[0].id);
      await client.query('COMMIT');
      return { kind: 'duplicate', approvalId: duplicate.rows[0].id };
    }
    const approval = await createApproval(client as unknown as pg.Pool, {
      id: input.id ?? randomUUID(), conversationId: input.conversationId, turnMessageId: input.message.id,
      toolName: input.operation.toolName, toolArgs: input.operation.args, sensitivity: 'destructive',
      traceId: input.traceId, approvedOperation: input.operation, proposalDetails: proposal,
    });
    await client.query(
      `INSERT INTO dashboard_agent_messages
        (id,conversation_id,role,content,tool_call_id,tool_name,tool_args,tool_result,model_used,pending_approval_id)
       VALUES($1,$2,'assistant',$3,$4,$5,$6,NULL,$7,$8)`,
      [input.message.id,input.conversationId,input.message.content,input.message.callId,input.message.toolName,
        JSON.stringify(input.message.args),input.message.model,approval.id],
    );
    await client.query('UPDATE dashboard_agent_conversations SET last_message_at=now(),updated_at=now() WHERE id=$1', [input.conversationId]);
    if (input.reviewPreparation) await linkReviewPreparation(client, input.reviewPreparation, approval.id);
    await client.query('COMMIT');
    return { kind: 'created', approval };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/** Expiry and the original model call's terminal result are indivisible. */
export async function expireProposalAndCompleteCall(pool: pg.Pool, input: {
  approval: Approval;
  code: 'proposal_state_changed' | 'proposal_review_required';
  resolvedBy?: string | null;
  afterExpire?: (client: pg.PoolClient) => Promise<void>;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const expired = await client.query(
      `UPDATE dashboard_agent_approvals SET status='expired',resolved_at=now(),resolved_by=$2,deny_reason=$3
       WHERE id=$1 AND status='pending' RETURNING id`,
      [input.approval.id,input.resolvedBy ?? null,input.code],
    );
    if (!expired.rowCount) { await client.query('ROLLBACK'); return false; }
    const paused = await client.query(
      `SELECT * FROM dashboard_agent_messages WHERE pending_approval_id=$1 AND conversation_id=$2 FOR UPDATE`,
      [input.approval.id,input.approval.conversationId],
    );
    const message = paused.rows[0];
    if (!message?.tool_call_id) throw new Error('proposal_paused_call_missing');
    const result = JSON.stringify({ code: input.code, ...(input.code === 'proposal_state_changed' ? { executed: false } : {}), request_authorizes_execution: false, message: 'Prepare this same operation again with current details and an explicit reason before requesting owner review. This request does not authorize execution.' });
    const replaced = await client.query(
      `UPDATE dashboard_agent_messages SET tool_name=$3,tool_args=$4,tool_result=$5
       WHERE conversation_id=$1 AND role='tool' AND tool_call_id=$2`,
      [input.approval.conversationId,message.tool_call_id,message.tool_name,JSON.stringify(message.tool_args),result],
    );
    if (!replaced.rowCount) await client.query(
      `INSERT INTO dashboard_agent_messages(conversation_id,role,content,tool_call_id,tool_name,tool_args,tool_result)
       VALUES($1,'tool','',$2,$3,$4,$5)`,
      [input.approval.conversationId,message.tool_call_id,message.tool_name,JSON.stringify(message.tool_args),result],
    );
    await client.query('UPDATE dashboard_agent_messages SET pending_approval_id=NULL WHERE id=$1', [message.id]);
    if (input.afterExpire) await input.afterExpire(client);
    await client.query('COMMIT'); return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
