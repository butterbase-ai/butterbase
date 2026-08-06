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
  /**
   * Which human resolved this approval (their platform user id / operator
   * approval feed caller). Nullable: existing rows predate this column, and
   * not every resolution path is guaranteed to supply one. Never backfilled.
   */
  resolvedBy: string | null;
  /**
   * Distributed trace id of the operator turn that created this approval
   * (see operator-turn.ts). Null for the human assistant's approvals and for
   * rows that predate 098_operator_trace_id.sql — those have no meaningful
   * backfill, since the original wake's id is gone.
   *
   * This is the field that lets a trace survive a gate: the turn that pauses
   * here may run in a process that exits before a human resolves the
   * approval, and the wake that eventually resumes the conversation needs
   * this value to report the SAME id rather than minting a fresh,
   * unjoinable one. See `findResumableApproval` / `markApprovalResumed`.
   */
  traceId: string | null;
  /**
   * Set the first time a wake consumes `traceId` to resume this approval's
   * conversation. Without this marker, EVERY wake after resolution — not
   * just the first — would see "most recent resolved approval with a trace
   * id" and replay the same id forever, instead of only the one wake that
   * actually continues the gated turn.
   */
  resumedAt: string | null;
};

const APPROVAL_COLS = `id, conversation_id, turn_message_id, tool_name, tool_args,
  sensitivity, status, trust_scope, deny_reason, created_at, resolved_at, resolved_by,
  trace_id, resumed_at`;

/** Same columns as APPROVAL_COLS, `a.`-prefixed for queries that JOIN dashboard_agent_conversations. */
const APPROVAL_COLS_JOIN = `a.id, a.conversation_id, a.turn_message_id, a.tool_name, a.tool_args, a.sensitivity, a.status, a.trust_scope, a.deny_reason, a.created_at, a.resolved_at, a.resolved_by, a.trace_id, a.resumed_at`;

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
    resolvedBy: row.resolved_by ?? null,
    traceId: row.trace_id ?? null,
    resumedAt: row.resumed_at ?? null,
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
    /**
     * The operator turn's trace id, when this approval is gating an operator
     * turn (see the `gated` checkpoint in operator-turn.ts/loop.ts). Absent
     * for the human assistant, which has no distributed trace.
     */
    traceId?: string | null;
  }
): Promise<Approval> {
  const result = await pool.query(
    `INSERT INTO dashboard_agent_approvals
     (conversation_id, turn_message_id, tool_name, tool_args, sensitivity, status, trace_id)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)
     RETURNING ${APPROVAL_COLS}`,
    [input.conversationId, input.turnMessageId, input.toolName, JSON.stringify(input.toolArgs), input.sensitivity, input.traceId ?? null]
  );

  return rowToApproval(result.rows[0]);
}

/**
 * The most recent approval for a conversation that (a) has already been
 * resolved (not pending — a resumable approval is one whose gate has
 * cleared), (b) carries a trace id worth carrying forward, and (c) has not
 * already been consumed by an earlier resume. Ordered by `created_at DESC`
 * and capped at one row: only the LATEST gate on a conversation is
 * resumable — an older resolved approval further back in history is not
 * what the next wake is continuing.
 *
 * Returns null when there is nothing to resume, which is the overwhelmingly
 * common case (an ordinary wake with no pending gate in its history).
 */
export async function findResumableApproval(
  pool: pg.Pool,
  conversationId: string,
): Promise<Approval | null> {
  const result = await pool.query(
    `SELECT ${APPROVAL_COLS}
     FROM dashboard_agent_approvals
     WHERE conversation_id = $1
       AND status != 'pending'
       AND trace_id IS NOT NULL
       AND resumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [conversationId],
  );
  return result.rows.length === 0 ? null : rowToApproval(result.rows[0]);
}

/**
 * Mark an approval's trace id as consumed by a resume. Idempotent — a second
 * call (e.g. a retried wake) is a no-op via the `resumed_at IS NULL` guard,
 * so it can never re-arm and be "resumed" a second time.
 */
export async function markApprovalResumed(pool: pg.Pool, approvalId: string): Promise<void> {
  await pool.query(
    `UPDATE dashboard_agent_approvals SET resumed_at = NOW() WHERE id = $1 AND resumed_at IS NULL`,
    [approvalId],
  );
}

/**
 * ---------------------------------------------------------------------------
 * THE SECOND APPROVAL WRITER (fix E) — and why it is shaped like this.
 * ---------------------------------------------------------------------------
 *
 * Until this function existed, the ONLY code that could insert an operator
 * approval row was the `operatorVerdict === 'approval'` branch in loop.ts. That
 * single-writer fact is load-bearing for a security property: the human-approved
 * replay path deliberately lifts the operator's substrate ACTION denials
 * (`principalMayExecute('human', …)` consults the tool-level allowlist only), so
 * an approval row that could carry `{action:'set_yolo'}` — or `approve` of an
 * arbitrary action id — would turn one click in the operator feed into exactly
 * the escalation `OPERATOR_DENIED_SUBSTRATE_ACTIONS` exists to prevent.
 *
 * loop.ts's branch is safe because `operatorPolicyFor` already returned
 * 'approval' for those args, and it never returns 'approval' for a denied
 * action. This writer cannot borrow that argument: it runs AFTER dispatch, on a
 * call whose verdict was 'allow'. So it is constrained STRUCTURALLY instead:
 *
 *  1. It takes no `toolName` and no `toolArgs`. The tool name is the module
 *     constant `SUBSTRATE_ESCALATION_TOOL` and the args object is built here,
 *     literally, as `{ action: 'approve', action_id }`. There is no parameter
 *     any caller could use to emit a different action, a different tool, or an
 *     extra argument. Adding one would be the bug; do not.
 *  2. The only caller-supplied value is `actionId`, which the call site reads
 *     out of SUBSTRATE'S RESPONSE (`readSubstrateEscalation` in
 *     substrate-approval-bridge.ts), never out of the model's tool arguments.
 *     It is additionally shape-checked below, so a hostile or malformed
 *     response cannot smuggle an object, an array or an unbounded blob into
 *     `tool_args`.
 *  3. No `org_id` is stored. The propose that produced this action_id already
 *     passed `operatorPolicyForOrg`'s cross-org guard, so its org was this
 *     operator's org; at resolution time `executeOnce` sends
 *     `x-organization-id` from the route's membership-checked `orgId`. Omitting
 *     the argument therefore targets the same substrate while leaving zero
 *     model-derived fields in the stored call.
 *
 * Net: the widest thing the replay path can be made to execute through this
 * writer is `manage_substrate approve` of one specific, substrate-issued action
 * id — which is precisely the human decision the row represents. It does not
 * widen the replay path by one action. `__tests__/operator-escalation-approval.test.ts`
 * pins all of this.
 */
export const SUBSTRATE_ESCALATION_TOOL = 'manage_substrate';

/**
 * Conservative shape check for a substrate ledger action id. Real ids are
 * `act_<ULID>` (action-executor.ts), so this is far wider than the current
 * format on purpose — it is a sanity bound, not a parser. What it rules out is
 * the thing that matters: anything that is not a short, opaque, single-token
 * string.
 */
const SUBSTRATE_ACTION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isValidSubstrateActionId(value: unknown): value is string {
  return typeof value === 'string' && SUBSTRATE_ACTION_ID_RE.test(value);
}

/**
 * Does this approval row represent "a human decision on a substrate action that
 * is ALREADY `proposed`"? True only for rows this writer created.
 *
 * Used by the deny path to decide whether there is a substrate-side action to
 * reject. Deliberately a pure predicate over the STORED row rather than a flag
 * column: the shape is the fact.
 */
export function readSubstrateEscalationActionId(approval: {
  toolName: string;
  toolArgs: unknown;
}): string | null {
  if (approval.toolName !== SUBSTRATE_ESCALATION_TOOL) return null;
  const args = approval.toolArgs;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const rec = args as Record<string, unknown>;
  if (rec.action !== 'approve') return null;
  return isValidSubstrateActionId(rec.action_id) ? rec.action_id : null;
}

/**
 * Create the approval for a substrate-escalated propose AND mark the paused
 * assistant row, atomically.
 *
 * ATOMICITY IS NOT HYGIENE HERE. `runOperatorTurn` refuses to start a turn
 * while `listPendingByConv` reports a pending row, and
 * `completeApprovalResolution` 400s if `getMessageByPendingApprovalId` finds
 * nothing. An approval row without its `pending_approval_id` marker would
 * therefore be unresolvable AND blocking — that org's operator wedged on an
 * approval no human could clear, in either direction. Unlike the pre-dispatch
 * pause (which creates the approval first and appends the message second, so a
 * crash leaves a pending row with no message and the message is never written),
 * this path cannot order its way out: the assistant row must exist before
 * dispatch, and the action id only exists after it. So both writes go in one
 * transaction.
 *
 * Returns null (having written nothing) if the target row is not a paused-able
 * assistant tool-call row in this conversation, or already carries a marker.
 */
export async function createSubstrateEscalationApproval(
  pool: pg.Pool,
  input: {
    conversationId: string;
    /** id of the assistant `tool_calls` row for the propose that escalated. */
    pausedMessageId: string;
    /** Substrate's own action id, from the propose RESPONSE. Never model args. */
    actionId: string;
    /** The operator turn's trace id. See `createApproval`'s `traceId` doc. */
    traceId?: string | null;
  },
): Promise<Approval | null> {
  if (!isValidSubstrateActionId(input.actionId)) return null;

  // Built here, not passed in. See the header above.
  const toolArgs = { action: 'approve', action_id: input.actionId };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO dashboard_agent_approvals
       (conversation_id, turn_message_id, tool_name, tool_args, sensitivity, status, trace_id)
       VALUES ($1, $2, $3, $4, 'destructive', 'pending', $5)
       RETURNING ${APPROVAL_COLS}`,
      [input.conversationId, input.pausedMessageId, SUBSTRATE_ESCALATION_TOOL, JSON.stringify(toolArgs), input.traceId ?? null],
    );

    const marked = await client.query(
      `UPDATE dashboard_agent_messages
       SET pending_approval_id = $1
       WHERE id = $2
         AND conversation_id = $3
         AND role = 'assistant'
         AND tool_call_id IS NOT NULL
         AND tool_result IS NULL
         AND pending_approval_id IS NULL`,
      [inserted.rows[0].id, input.pausedMessageId, input.conversationId],
    );
    if ((marked.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query('COMMIT');
    return rowToApproval(inserted.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
    /** Who resolved it. Optional/nullable — see Approval.resolvedBy. */
    resolvedBy?: string | null;
  }
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE dashboard_agent_approvals
     SET status = $2, trust_scope = $3, deny_reason = $4, resolved_at = NOW(), resolved_by = $5
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [id, input.status, input.trustScope ?? null, input.denyReason ?? null, input.resolvedBy ?? null]
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
