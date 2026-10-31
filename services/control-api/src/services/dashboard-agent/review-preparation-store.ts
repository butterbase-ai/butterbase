import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { ApprovedOperation } from './approval-operation.js';
import type { ProposalExplanation } from './approval-proposal.js';

export type ReviewPreparationState = 'waiting' | 'running' | 'replaced' | 'blocked' | 'failed';
export interface ReviewPreparation {
  approvalId: string; state: ReviewPreparationState; replacementApprovalId: string | null;
  safeErrorCode: string | null; attemptCount: number; createdAt: string; updatedAt: string;
  explanation?: ProposalExplanation;
}
export interface ReviewPreparationClaim {
  approvalId: string; organizationId: string; conversationId: string;
  operation: ApprovedOperation; intentFingerprint: string; token: string;
}
const timestamp = (value: Date | string) => value instanceof Date ? value.toISOString() : value;

/** Safe projection: no operation, arguments, private transcript or provider error. */
export async function listReviewPreparations(pool: pg.Pool, organizationId: string): Promise<ReviewPreparation[]> {
  const { rows } = await pool.query(`SELECT * FROM (
    SELECT p.approval_id,p.state,p.replacement_approval_id,p.safe_error_code,p.attempt_count,p.created_at,p.updated_at
    FROM dashboard_agent_review_preparations p
    JOIN dashboard_agent_conversations c ON c.id=p.conversation_id
    WHERE p.organization_id=$1 AND c.organization_id=$1
    UNION ALL
    SELECT a.id,'failed',NULL::uuid,'proposal_not_prepared',0,a.created_at,COALESCE(a.resolved_at,a.created_at)
    FROM dashboard_agent_approvals a JOIN dashboard_agent_conversations c ON c.id=a.conversation_id
    WHERE c.organization_id=$1 AND (c.origin='office' OR c.user_id='operator:' || $1)
      AND a.status='expired' AND a.deny_reason='proposal_review_required'
      AND COALESCE(a.execution_outcome->>'state','not_started') NOT IN ('running','unconfirmed','succeeded')
      AND NOT EXISTS(SELECT 1 FROM dashboard_agent_tool_executions e WHERE e.approval_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM dashboard_agent_review_preparations p WHERE p.approval_id=a.id)
    ) requests ORDER BY (state!='replaced') DESC,updated_at DESC LIMIT 100`, [organizationId]);
  return rows.map(row => ({ approvalId: row.approval_id, state: row.state,
    replacementApprovalId: row.replacement_approval_id, safeErrorCode: row.safe_error_code,
    attemptCount: row.attempt_count, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) }));
}

/** One request per turn. Expired leases are reclaimable after process loss. */
export async function claimReviewPreparation(pool: pg.Pool, organizationId: string, conversationId: string): Promise<ReviewPreparationClaim | null> {
  const token = randomUUID();
  const { rows } = await pool.query(`UPDATE dashboard_agent_review_preparations SET
    state='running',claim_token=$3,lease_until=now()+interval '20 minutes',
    attempt_count=attempt_count+1,safe_error_code=NULL,updated_at=now()
    WHERE approval_id=(SELECT approval_id FROM dashboard_agent_review_preparations
      WHERE organization_id=$1 AND conversation_id=$2
        AND (state='waiting' OR (state='running' AND lease_until<=now()))
      ORDER BY created_at,approval_id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`, [organizationId,conversationId,token]);
  const row = rows[0];
  return row ? { approvalId: row.approval_id, organizationId, conversationId,
    operation: row.operation, intentFingerprint: row.intent_fingerprint, token } : null;
}

/** Only the still-current worker may settle an unsuccessful preparation. */
export async function finishReviewPreparation(pool: pg.Pool, claim: ReviewPreparationClaim, state: 'blocked' | 'failed' | 'waiting', safeErrorCode: string): Promise<void> {
  await pool.query(`UPDATE dashboard_agent_review_preparations SET state=$3,safe_error_code=$4,
    claim_token=NULL,lease_until=NULL,updated_at=now()
    WHERE approval_id=$1 AND claim_token=$2 AND state='running' AND lease_until>now()`,
    [claim.approvalId,claim.token,state,safeErrorCode]);
}

/** Must run inside the replacement approval's transaction, before any insert. */
export async function lockReviewPreparation(client: pg.PoolClient, claim: ReviewPreparationClaim, organizationId: string, conversationId: string, intentFingerprint: string): Promise<void> {
  if (claim.organizationId !== organizationId || claim.conversationId !== conversationId || claim.intentFingerprint !== intentFingerprint) throw new Error('proposal_preparation_mismatch');
  const { rowCount } = await client.query(`SELECT approval_id FROM dashboard_agent_review_preparations
    WHERE approval_id=$1 AND organization_id=$2 AND conversation_id=$3 AND intent_fingerprint=$4
      AND claim_token=$5 AND state='running' AND lease_until>now() FOR UPDATE`,
    [claim.approvalId,organizationId,conversationId,intentFingerprint,claim.token]);
  if (!rowCount) throw new Error('proposal_preparation_claim_lost');
}

export async function linkReviewPreparation(client: pg.PoolClient, claim: ReviewPreparationClaim, replacementApprovalId: string): Promise<void> {
  await client.query(`UPDATE dashboard_agent_review_preparations SET state='replaced',replacement_approval_id=$3,
    safe_error_code=NULL,claim_token=NULL,lease_until=NULL,updated_at=now()
    WHERE approval_id=$1 AND claim_token=$2 AND state='running'`, [claim.approvalId,claim.token,replacementApprovalId]);
}
