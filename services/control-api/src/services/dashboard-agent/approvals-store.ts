import pg from 'pg';
import { operatorUserId } from './operator-store.js';

export type Approval = {
  id: string;
  conversationId: string;
  turnMessageId: string;
  toolName: string;
  toolArgs: unknown;
  sensitivity: 'confirm' | 'destructive';
  status: 'pending' | 'approved' | 'denied' | 'expired';
  trustScope: 'conversation' | null;
  denyReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

const APPROVAL_COLS = `id, conversation_id, turn_message_id, tool_name, tool_args,
  sensitivity, status, trust_scope, deny_reason, created_at, resolved_at`;

/** Same columns as APPROVAL_COLS, `a.`-prefixed for queries that JOIN dashboard_agent_conversations. */
const APPROVAL_COLS_JOIN = `a.id, a.conversation_id, a.turn_message_id, a.tool_name, a.tool_args, a.sensitivity, a.status, a.trust_scope, a.deny_reason, a.created_at, a.resolved_at`;

function rowToApproval(row: any): Approval {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnMessageId: row.turn_message_id,
    toolName: row.tool_name,
    toolArgs: row.tool_args,
    sensitivity: row.sensitivity,
    status: row.status,
    trustScope: row.trust_scope,
    denyReason: row.deny_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * Create a new approval record. Stores all necessary info for later
 * approval/denial/expiration. Returns the created approval.
 */
export async function createApproval(
  pool: pg.Pool,
  input: {
    conversationId: string;
    turnMessageId: string;
    toolName: string;
    toolArgs: unknown;
    sensitivity: 'confirm' | 'destructive';
  }
): Promise<Approval> {
  const result = await pool.query(
    `INSERT INTO dashboard_agent_approvals
     (conversation_id, turn_message_id, tool_name, tool_args, sensitivity, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING ${APPROVAL_COLS}`,
    [input.conversationId, input.turnMessageId, input.toolName, JSON.stringify(input.toolArgs), input.sensitivity]
  );

  return rowToApproval(result.rows[0]);
}

/**
 * Get an approval by ID, scoped to a user (returns null if user doesn't own
 * the conversation or approval doesn't exist).
 */
export async function getApproval(
  pool: pg.Pool,
  id: string,
  userId: string
): Promise<Approval | null> {
  const result = await pool.query(
    `SELECT ${APPROVAL_COLS_JOIN}
     FROM dashboard_agent_approvals a
     JOIN dashboard_agent_conversations c ON a.conversation_id = c.id
     WHERE a.id = $1 AND c.user_id = $2`,
    [id, userId]
  );

  return result.rows.length === 0 ? null : rowToApproval(result.rows[0]);
}

/**
 * Org-scoped lookup for the OPERATOR's approvals: any member of the org may
 * resolve them (the operator conversation's user_id is the sentinel
 * `operator:<org>`, which no human user_id ever matches, so this is the only
 * path a human can use to reach it).
 *
 * The `user_id` predicate is load-bearing, not decorative. The operator
 * approval routes authorise on org membership alone, so without it this would
 * match ANY conversation carrying an organization_id. That is safe today only
 * because createConversation never sets that column — an unstated invariant
 * nothing enforces. The moment a migration, an analytics feature, or org-scoped
 * chat backfills it, these routes would silently widen to "any org member can
 * read another member's tool_args and execute their gated tool calls". Scope
 * structurally instead of relying on that accident.
 *
 * operatorUserId is the single source of truth for the sentinel format; do not
 * inline the `operator:` prefix here.
 */
export async function getApprovalForOrg(
  pool: pg.Pool,
  id: string,
  orgId: string
): Promise<Approval | null> {
  const result = await pool.query(
    `SELECT ${APPROVAL_COLS_JOIN}
     FROM dashboard_agent_approvals a
     JOIN dashboard_agent_conversations c ON a.conversation_id = c.id
     WHERE a.id = $1 AND c.organization_id = $2 AND c.user_id = $3`,
    [id, orgId, operatorUserId(orgId)]
  );

  return result.rows.length === 0 ? null : rowToApproval(result.rows[0]);
}

/**
 * List all pending approvals for a conversation.
 */
export async function listPendingByConv(
  pool: pg.Pool,
  conversationId: string
): Promise<Approval[]> {
  const result = await pool.query(
    `SELECT ${APPROVAL_COLS}
     FROM dashboard_agent_approvals
     WHERE conversation_id = $1 AND status = 'pending'
     ORDER BY created_at ASC`,
    [conversationId]
  );

  return result.rows.map(rowToApproval);
}

/**
 * List an org's pending OPERATOR approvals (the operator conversation's
 * user_id sentinel excludes them from any user-scoped query).
 *
 * Scoped to the operator conversation, not merely to the org — see
 * getApprovalForOrg for why that predicate is load-bearing.
 */
export async function listPendingByOrg(pool: pg.Pool, orgId: string): Promise<Approval[]> {
  const result = await pool.query(
    `SELECT ${APPROVAL_COLS_JOIN}
     FROM dashboard_agent_approvals a
     JOIN dashboard_agent_conversations c ON a.conversation_id = c.id
     WHERE c.organization_id = $1 AND c.user_id = $2 AND a.status = 'pending'
     ORDER BY a.created_at ASC`,
    [orgId, operatorUserId(orgId)]
  );

  return result.rows.map(rowToApproval);
}

/**
 * Resolve an approval (approve, deny, or mark as expired). Updates status,
 * trust_scope, deny_reason, and resolved_at.
 *
 * The UPDATE is conditioned on `status = 'pending'` so that two concurrent
 * resolve attempts can't both "win" (TOCTOU race) — only one call will
 * affect a row and get a truthy return. Callers MUST check the return value
 * rather than relying solely on a prior read-side status check.
 */
export async function resolveApproval(
  pool: pg.Pool,
  id: string,
  input: {
    status: 'approved' | 'denied' | 'expired';
    trustScope?: 'conversation';
    denyReason?: string;
  }
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE dashboard_agent_approvals
     SET status = $2, trust_scope = $3, deny_reason = $4, resolved_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [id, input.status, input.trustScope ?? null, input.denyReason ?? null]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Check if the user has previously approved a tool for this conversation
 * with conversation-wide trust scope. Returns true if at least one prior
 * approved row for the same (conversation_id, tool_name) has trust_scope='conversation'.
 */
export async function checkTrust(
  pool: pg.Pool,
  conversationId: string,
  toolName: string
): Promise<boolean> {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1 FROM dashboard_agent_approvals
      WHERE conversation_id = $1
        AND tool_name = $2
        AND status = 'approved'
        AND trust_scope = 'conversation'
      LIMIT 1
     ) AS trusted`,
    [conversationId, toolName]
  );

  return result.rows[0]?.trusted ?? false;
}
