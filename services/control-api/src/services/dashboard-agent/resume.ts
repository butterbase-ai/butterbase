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
  | { ok: false; code: 404 | 409 | 400; error: string };

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

  // 2. Status check — only pending approvals can be resolved.
  if (approval.status !== 'pending') {
    return { ok: false, code: 409, error: `approval already ${approval.status}` };
  }

  // 3. Find the paused assistant tool-call row.
  const pausedMessage = await getMessageByPendingApprovalId(pool, approvalId);
  if (!pausedMessage || !pausedMessage.toolCallId) {
    return { ok: false, code: 400, error: 'no paused tool call found for this approval' };
  }

  // 4. Resolve the approval row + execute/synthesize the tool result.
  let toolResult: unknown;
  if (resolution.status === 'approved') {
    await resolveApproval(pool, approvalId, {
      status: 'approved',
      trustScope: resolution.trustScope,
    });

    const call = await callMcpTool(approval.toolName, approval.toolArgs, jwt);
    toolResult = call.ok ? call.result : { error: call.error };
  } else {
    await resolveApproval(pool, approvalId, {
      status: 'denied',
      denyReason: resolution.reason,
    });

    const message = `User denied.${resolution.reason ? ` Reason: ${resolution.reason}` : ''}`;
    toolResult = { ok: false, error: message };
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
