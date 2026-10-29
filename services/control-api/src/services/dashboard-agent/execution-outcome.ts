import type pg from 'pg';
import type { Approval } from './approvals-store.js';
import { ExecutionOutcomeSchema, type ExecutionOutcome } from './approval-proposal.js';
import type { McpCallResult } from './mcp-client.js';

export function isConfirmedExecution(approval: Pick<Approval, 'toolName' | 'toolArgs'>, call: McpCallResult): boolean {
  if (!call?.ok || (call.result as any)?.isError === true) return false;
  if (approval.toolName === 'manage_substrate' && ['propose', 'approve'].includes((approval.toolArgs as any)?.action)) {
    const result = call.result as any;
    try {
      const text = result?.content?.find((item: any) => item.type === 'text')?.text;
      if (!text) return false;
      const parsed = JSON.parse(text);
      if ((approval.toolArgs as any)?.action === 'approve') return parsed?.executed === true;
      return parsed?.executed === true || parsed?.requires_approval === false;
    } catch { return false; }
  }
  return true;
}
export async function readConfirmedExecution(pool: pg.Pool, approval: Approval): Promise<McpCallResult | null> {
  const { rows } = await pool.query('SELECT result FROM dashboard_agent_tool_executions WHERE approval_id=$1', [approval.id]);
  return rows[0] && isConfirmedExecution(approval, rows[0].result) ? rows[0].result : null;
}
export async function recordExecutionOutcome(pool: pg.Pool, approvalId: string, outcome: ExecutionOutcome): Promise<void> {
  const parsed = ExecutionOutcomeSchema.parse(outcome);
  await pool.query('UPDATE dashboard_agent_approvals SET execution_outcome=$2 WHERE id=$1', [approvalId, JSON.stringify(parsed)]);
}
