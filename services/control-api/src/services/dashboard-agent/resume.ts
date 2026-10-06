/**
 * Resume-turn helper (Plan 3b Task 3).
 *
 * When the loop pauses a turn on a gated tool call (Plan 3b Task 2), it
 * persists an assistant row with `tool_call_id` set, `tool_result: null`,
 * and `pending_approval_id` pointing at the created approval — then
 * terminates the turn without a matching `role: 'tool'` row.
 *
 * Most chat-completions APIs (including the AI gateway used here) reject a
 * conversation history that ends with an assistant `tool_calls` message and
 * no corresponding tool result. So resuming is NOT just "call runAgentTurn
 * again" — we must first:
 *
 *   1. Actually execute the gated tool (approve) or synthesize a denial
 *      result (deny).
 *   2. Persist a `role: 'tool'` row with that result, `tool_call_id`
 *      matching the paused assistant row.
 *   3. Clear `pending_approval_id` on the paused row (historical marker no
 *      longer needed once the loop has moved on).
 *   4. THEN start a new agent turn with an EMPTY `userMessage` — the
 *      gateway sees the full prior history (now valid) and continues
 *      generating from there.
 *
 * Steps 1-3 apply to EVERY approval, not just the human assistant's. The
 * headless operator has exactly ONE conversation per org, reused forever, so
 * skipping them there does not break one chat — it wedges that org's operator
 * permanently, on every wake, with no rotation and no recovery. That is why
 * `completeApprovalResolution` is exported and shared rather than reimplemented
 * on the operator side (see resolveOperatorApproval in routes/dashboard-agent.ts).
 * Step 4 is the human assistant's alone: the operator's turn is not resumed
 * inline, its loop picks the completed history up on its next wake.
 */

import pg from 'pg';
import { getApproval, resolveApproval, type Approval } from './approvals-store.js';
import {
  getMessageByPendingApprovalId,
  clearPendingApproval,
  appendMessage,
  replaceToolResultForCall,
  stripJsonbNulls,
} from './store.js';
import { callMcpTool, type McpCallResult } from './mcp-client.js';

export type ResolutionInput =
  | { status: 'approved'; trustScope?: 'conversation' }
  | { status: 'denied'; reason?: string };

export type ResolveOutcome =
  | { ok: true; approval: Approval }
  | { ok: false; code: 404 | 409 | 400 | 502; error: string };

/**
 * How an approved tool call actually gets executed. The two callers differ
 * ONLY here:
 *
 *  - the human assistant (`resolveApprovalAndPersistResult` below) calls the
 *    MCP tool directly under the approver's JWT;
 *  - the headless operator's approval feed (`resolveOperatorApproval` in
 *    routes/dashboard-agent.ts) goes through `executeOnce`, which holds a
 *    Postgres advisory lock on the approval id so a retried approve fires the
 *    tool exactly once.
 *
 * Everything after execution — resolving the approval row, writing the
 * `role: 'tool'` row that completes the assistant/tool pair, clearing
 * `pending_approval_id` — is identical and lives in one place below. It has to:
 * a second copy that drifted from this one is exactly how the operator path
 * shipped without any of it and wedged its conversation permanently.
 */
export type ApprovalExecutor = (approval: Approval) => Promise<McpCallResult>;

/**
 * Ownership + status checks, execute-or-synthesize the tool result, and
 * persist the follow-up `role: 'tool'` row. Does NOT start the resumed
 * agent turn — callers stream that separately (see the route) so the SSE
 * hijack only happens once we know we're past all the synchronous guards.
 */
export async function resolveApprovalAndPersistResult(
  pool: pg.Pool,
  input: {
    approvalId: string;
    userId: string;
    jwt: string;
    resolution: ResolutionInput;
  }
): Promise<ResolveOutcome> {
  const { approvalId, userId, jwt, resolution } = input;

  // 1. Ownership check.
  const approval = await getApproval(pool, approvalId, userId);
  if (!approval) {
    return { ok: false, code: 404, error: 'approval not found' };
  }

  return completeApprovalResolution(pool, {
    approval,
    resolution,
    resolvedBy: userId,
    execute: (a) => callMcpTool(a.toolName, a.toolArgs, jwt),
  });
}

/**
 * Steps 1-3 of this module's header, for an approval the caller has ALREADY
 * fetched and authorised. Shared by the human assistant and the operator
 * approvals feed; the only difference between them is the `execute` callback.
 *
 * Callers MUST have established that the approval belongs to the caller —
 * this function does not authorise.
 */
export async function completeApprovalResolution(
  pool: pg.Pool,
  params: {
    approval: Approval;
    resolution: ResolutionInput;
    execute: ApprovalExecutor;
    /**
     * The resolving human's id, recorded on the approval row (resolved_by).
     * Optional/nullable — see Approval.resolvedBy: not every caller is
     * guaranteed to have one, and existing rows predate the column.
     */
    resolvedBy?: string | null;
    /**
     * OPTIONAL, deny path only. Undo/close whatever the approval refers to on
     * the far side, for the one approval kind where denial is not a no-op.
     *
     * Only the operator's SUBSTRATE-ESCALATED approvals need this: those are
     * raised AFTER the propose already dispatched, so a real action sits in
     * substrate's ledger in `proposed` and denying at our layer alone would
     * leave it there forever. Every other approval — the human assistant's, and
     * the operator's pre-emptive gate — paused BEFORE dispatch, so nothing
     * exists to undo. See `rejectEscalatedSubstrateAction`.
     *
     * The human assistant never supplies this, so its behaviour is byte-for-byte
     * unchanged.
     *
     * BEST-EFFORT BY CONTRACT. Its outcome is folded into the tool result the
     * model sees, but a failure never blocks the denial: an approval a human
     * cannot deny wedges the org's one operator conversation, which is strictly
     * worse than a stale row in substrate. Callers must not throw from it.
     */
    denyCleanup?: (approval: Approval) => Promise<{ attempted: boolean; ok: boolean; error?: string }>;
  }
): Promise<ResolveOutcome> {
  const { approval, resolution, execute, resolvedBy, denyCleanup } = params;
  const approvalId = approval.id;

  // 2. Status check — fast-path 404/409 without touching MCP or the DB
  // write path. This is NOT the source of truth for concurrency safety —
  // resolveApproval's conditional UPDATE (WHERE status = 'pending') is the
  // real guard against a double-resolve race. Two concurrent requests can
  // both pass this read, but only one will win the UPDATE below.
  if (approval.status !== 'pending') {
    return { ok: false, code: 409, error: `approval already ${approval.status}` };
  }

  // 3. Find the paused assistant tool-call row.
  const pausedMessage = await getMessageByPendingApprovalId(pool, approvalId);
  if (!pausedMessage || !pausedMessage.toolCallId) {
    return { ok: false, code: 400, error: 'no paused tool call found for this approval' };
  }

  // 4. Execute/synthesize the tool result, THEN resolve the approval row.
  //
  // Ordering matters for the approve path: we execute the gated MCP tool
  // BEFORE flipping the approval to 'approved'. If MCP dispatch fails, the
  // approval is left 'pending' (never resolved) so a retry can re-attempt
  // the resolve — we haven't committed to a result we can't stand behind,
  // and no orphaned `role: 'tool'` row gets written.
  //
  // The final `resolveApproval` call (conditioned on status='pending') is
  // also what atomically defeats a concurrent double-resolve: whichever
  // request's UPDATE actually affects a row is the one that proceeds to
  // persist the tool-result row and continue the turn. It must stay AHEAD of
  // the append below for that reason — moving it after would let two
  // concurrent resolvers each write a `role: 'tool'` row for the same
  // tool_call_id, which is a worse kind of invalid history than the one this
  // module exists to prevent.
  let toolResult: unknown;
  if (resolution.status === 'approved') {
    const call = await execute(approval);
    if (!call.ok) {
      return { ok: false, code: 502, error: `Tool execution failed: ${call.error}` };
    }
    toolResult = call.result;

    const resolved = await resolveApproval(pool, approvalId, {
      status: 'approved',
      trustScope: resolution.trustScope,
      resolvedBy,
    });
    if (!resolved) {
      return { ok: false, code: 409, error: `approval already resolved` };
    }
  } else {
    // The deny reason is caller-supplied and lands in deny_reason, a TEXT
    // column. Postgres rejects NUL there too — `invalid byte sequence for
    // encoding "UTF8": 0x00` — which would throw out of resolveApproval and
    // 500 the request on nothing but a malformed input string.
    const reason =
      typeof resolution.reason === 'string'
        ? (stripJsonbNulls(resolution.reason) as string)
        : resolution.reason;

    // Close out the far side BEFORE flipping the row, so a retry of a denial
    // whose cleanup failed can still re-attempt it. Never allowed to abort the
    // denial itself — see denyCleanup's contract.
    let cleanup: { attempted: boolean; ok: boolean; error?: string } = { attempted: false, ok: true };
    if (denyCleanup) {
      try {
        cleanup = await denyCleanup(approval);
      } catch (err) {
        cleanup = { attempted: true, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const message = `User denied.${reason ? ` Reason: ${reason}` : ''}`;
    toolResult = cleanup.attempted
      ? {
          ok: false,
          error: message,
          // Stated explicitly so a stale substrate action is visible in the
          // transcript rather than silently left behind.
          substrate_action_rejected: cleanup.ok,
          ...(cleanup.ok
            ? {}
            : { substrate_reject_error: cleanup.error ?? 'unknown error' }),
        }
      : { ok: false, error: message };

    const resolved = await resolveApproval(pool, approvalId, {
      status: 'denied',
      denyReason: reason,
      resolvedBy,
    });
    if (!resolved) {
      return { ok: false, code: 409, error: `approval already resolved` };
    }
  }

  // 5. Persist the tool-result row that completes the assistant/tool pair.
  //
  // stripJsonbNulls is load-bearing, not hygiene. dashboard_agent_messages.
  // tool_result is JSONB and Postgres rejects NUL (U+0000) with `unsupported
  // Unicode escape sequence`. A single NUL anywhere in a tool result used to
  // throw HERE — after the tool had fired and after resolveApproval had
  // already flipped the row — leaving no `role: 'tool'` row, an uncleared
  // marker, a 500 to the caller, and a retry that 409s on the status guard.
  // That is the permanent wedge this module exists to prevent, reachable with
  // no crash at all. tool-bridge.ts sanitises its execution-cache row for the
  // same reason but deliberately returns the raw result to its caller, so the
  // constraint has to be met again at every write.
  //
  // Residual window: a process crash or DB outage between the resolveApproval
  // above and this append still leaves the conversation ending in an
  // unanswered assistant tool_calls row while the approval reads resolved.
  // Closing it entirely needs all three writes in one transaction, which
  // appendMessage's own BEGIN/COMMIT prevents today. The append-then-clear
  // order below is deliberate: a crash between them leaves a valid history
  // plus a stale marker, which is harmless.
  //
  // REPLACE-OR-APPEND, added 2026-08-08. An OPERATOR gate no longer leaves its
  // assistant `tool_calls` row unanswered while the owner thinks: the next wake
  // writes a placeholder `role:'tool'` row ("not executed — waiting on the
  // owner") in the adjacent position, so that the operator can keep working
  // without a turn's worth of messages landing between the two halves of the
  // pair (see `closeUnansweredToolCall`). When that placeholder exists, the
  // owner's real answer must OVERWRITE it: appending would leave a second
  // `role:'tool'` row for the same tool_call_id, at the end of the
  // conversation, with no assistant call in front of it — the same invalid
  // history in a new shape.
  //
  // When no placeholder exists — the human assistant, always; an operator
  // approval raised before this existed — `replaceToolResultForCall` matches
  // nothing and the append below runs exactly as it always did. That is why
  // this is a fallback rather than a branch on principal: it is keyed on what
  // is actually in the conversation, not on an assumption about who owns it.
  const toolName = approval.toolName;
  const toolArgs = stripJsonbNulls(approval.toolArgs);
  const sanitizedResult = stripJsonbNulls(toolResult);
  const replaced = await replaceToolResultForCall(pool, approval.conversationId, pausedMessage.toolCallId, {
    toolName,
    toolArgs,
    toolResult: sanitizedResult,
  });
  if (!replaced) {
    await appendMessage(pool, approval.conversationId, {
      role: 'tool',
      content: '',
      toolCallId: pausedMessage.toolCallId,
      toolName,
      toolArgs,
      toolResult: sanitizedResult,
    });
  }

  // 6. Clear the pending marker on the paused assistant row.
  await clearPendingApproval(pool, pausedMessage.id);

  return { ok: true, approval };
}
