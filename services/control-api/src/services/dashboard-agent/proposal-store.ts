import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createApproval, type Approval } from './approvals-store.js';
import type { ApprovedOperation } from './approval-operation.js';
import { PreparedProposalSchema, type PreparedProposal } from './approval-proposal.js';

/** Only server-authored completion results in this authorized conversation count. */
export async function findParkedProposalIntent(pool: pg.Pool, organizationId: string, conversationId: string, fingerprint: string): Promise<string | null> {
  const { rows } = await pool.query<{ action_id: string }>(
    `SELECT DISTINCT m.tool_result->'parkedProposal'->>'actionId' AS action_id
       FROM dashboard_agent_messages m JOIN dashboard_agent_conversations c ON c.id=m.conversation_id
      WHERE c.id=$1 AND c.organization_id=$2 AND m.role='tool'
        AND m.tool_name='manage_substrate' AND m.tool_args->>'action'='propose'
        AND m.tool_result->>'code'='proposal_incomplete'
        AND m.tool_result->'parkedProposal'->>'intentFingerprint'=$3`,
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
    await client.query('COMMIT');
    return { kind: 'created', approval };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
