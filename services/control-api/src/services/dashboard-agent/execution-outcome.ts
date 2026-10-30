import type pg from 'pg';
import type { Approval } from './approvals-store.js';
import { ExecutionOutcomeSchema, type ExecutionOutcome } from './approval-proposal.js';
import type { McpCallResult } from './mcp-client.js';

type ExecutionState = 'succeeded' | 'pending' | 'failed' | 'unconfirmed';
type Executable = Pick<Approval, 'toolName' | 'toolArgs'>;
function envelopeJson(result: unknown): any {
  try {
    const text = (result as any)?.content?.find((item: any) => item.type === 'text')?.text;
    return typeof text === 'string' ? JSON.parse(text) : null;
  } catch { return null; }
}
/** A transport-success envelope is not proof that an effect succeeded. */
export function executionState(approval: Executable, call: McpCallResult): ExecutionState {
  if (!call?.ok || (call.result as any)?.isError === true) return 'unconfirmed';
  if (approval.toolName === 'invoke_function') {
    const result = envelopeJson(call.result);
    return typeof result?.status === 'number' && result.status >= 200 && result.status < 400 ? 'succeeded' : 'unconfirmed';
  }
  if (approval.toolName === 'manage_substrate' && ['propose', 'approve'].includes((approval.toolArgs as any)?.action)) {
    const result = envelopeJson(call.result);
    if (!result) return 'unconfirmed';
    if ((approval.toolArgs as any)?.action === 'approve') return result.executed === true ? 'succeeded' : 'unconfirmed';
    if (result.status === 'rejected' || result.verdict?.result === 'blocked') return 'failed';
    if (result.executed === true || result.status === 'executed') return 'succeeded';
    if (result.requires_approval === true && typeof result.action_id === 'string') return 'pending';
    // Older replicas omit status. Only their explicit committed automatic
    // verdict proves execution; an ambiguous historical replay does not.
    return result.requires_approval === false && ['auto_approved', 'auto_approved_yolo', 'auto_approved_user_override'].includes(result.verdict?.result) ? 'succeeded' : 'unconfirmed';
  }
  return 'succeeded';
}
export function normalizeExecutionResult(approval: Executable, call: McpCallResult): McpCallResult {
  if (!call.ok) return call;
  const state = executionState(approval, call);
  if (state === 'unconfirmed') return { ok: false, code: 'execution_unconfirmed', error: 'The operation may have taken effect; reconcile its outcome before retrying.' };
  if (state === 'failed') return { ok: false, code: 'substrate_rejected', error: 'Substrate rejected this operation before execution.' };
  return call;
}
export function isConfirmedExecution(approval: Executable, call: McpCallResult): boolean { return executionState(approval, call) === 'succeeded'; }
export async function readConfirmedExecution(pool: pg.Pool, approval: Approval): Promise<McpCallResult | null> {
  const { rows } = await pool.query('SELECT result FROM dashboard_agent_tool_executions WHERE approval_id=$1', [approval.id]);
  return rows[0] && isConfirmedExecution(approval, rows[0].result) ? rows[0].result : null;
}
export async function hasUnconfirmedExecution(pool: pg.Pool, approvalId: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT result FROM dashboard_agent_tool_executions WHERE approval_id=$1', [approvalId]);
  return rows[0]?.result?.code === 'execution_unconfirmed';
}
export async function recordExecutionOutcome(pool: Pick<pg.Pool, 'query'>, approvalId: string, outcome: ExecutionOutcome): Promise<void> {
  const parsed = ExecutionOutcomeSchema.parse(outcome);
  await pool.query('UPDATE dashboard_agent_approvals SET execution_outcome=$2 WHERE id=$1', [approvalId, JSON.stringify(parsed)]);
}
/** Legacy approvals need the same uncertainty barrier as prepared reviews. */
export async function recordUnconfirmedOutcome(pool: Pick<pg.Pool, 'query'>, approvalId: string): Promise<void> {
  const { rows } = await pool.query('SELECT execution_outcome FROM dashboard_agent_approvals WHERE id=$1', [approvalId]);
  const parsed = ExecutionOutcomeSchema.safeParse(rows[0]?.execution_outcome);
  const previous = parsed.success ? parsed.data : null;
  const now = new Date().toISOString();
  await recordExecutionOutcome(pool, approvalId, {
    version: 1, state: 'unconfirmed', attemptCount: Math.max(1, previous?.attemptCount ?? 0),
    startedAt: previous?.startedAt ?? now, finishedAt: now,
    safeErrorCode: 'execution_unconfirmed', resultReference: null,
  });
}
export function unconfirmedExecution(): McpCallResult {
  return { ok: false, code: 'execution_unconfirmed', error: 'The operation may have taken effect; reconcile its outcome before retrying.' };
}
