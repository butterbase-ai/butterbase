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
 */

import pg from 'pg';
import { getApproval, resolveApproval, type Approval } from './approvals-store.js';
import { getMessageByPendingApprovalId, clearPendingApproval, appendMessage } from './store.js';
import { callMcpTool } from './mcp-client.js';

export type ResolutionInput =
  | { status: 'approved'; trustScope?: 'conversation' }
  | { status: 'denied'; reason?: string };

export type ResolveOutcome =
  | { ok: true; approval: Approval }
  | { ok: false; code: 404 | 409 | 400 | 502; error: string };

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
  // persist the tool-result row and continue the turn.
  let toolResult: unknown;
  if (resolution.status === 'approved') {
    const call = await callMcpTool(approval.toolName, approval.toolArgs, jwt);
    if (!call.ok) {
      return { ok: false, code: 502, error: `Tool execution failed: ${call.error}` };
    }
    toolResult = call.result;

    const resolved = await resolveApproval(pool, approvalId, {
      status: 'approved',
      trustScope: resolution.trustScope,
    });
    if (!resolved) {
      return { ok: false, code: 409, error: `approval already resolved` };
    }
  } else {
    const message = `User denied.${resolution.reason ? ` Reason: ${resolution.reason}` : ''}`;
    toolResult = { ok: false, error: message };

    const resolved = await resolveApproval(pool, approvalId, {
      status: 'denied',
      denyReason: resolution.reason,
    });
    if (!resolved) {
      return { ok: false, code: 409, error: `approval already resolved` };
    }
  }

  // 5. Persist the tool-result row that completes the assistant/tool pair.
  await appendMessage(pool, approval.conversationId, {
    role: 'tool',
    content: '',
    toolCallId: pausedMessage.toolCallId,
    toolName: approval.toolName,
    toolArgs: approval.toolArgs,
    toolResult,
  });

  // 6. Clear the pending marker on the paused assistant row.
  await clearPendingApproval(pool, pausedMessage.id);

  return { ok: true, approval };
}
