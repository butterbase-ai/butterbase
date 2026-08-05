import pg from 'pg';
import { callMcpTool, type McpCallResult } from './mcp-client.js';

/**
 * Server-side allowlist. The operator runs model-generated intent, so this
 * list is authoritative and is never read from anything the model can edit.
 *
 * manage_billing, manage_app and manage_repo are deliberately absent: nothing
 * in v1 lets the operator spend money or delete infrastructure.
 *
 * manage_integrations is present and ungated. That is a deliberately accepted
 * risk recorded 2026-08-05: it is the real outbound-email path, so the operator
 * can send mail without a human in the loop. Do not silently change this
 * behaviour — revisit the decision instead.
 */
export const OPERATOR_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'manage_substrate',
  'manage_integrations',
  'manage_people',
  'query_audit_logs',
  'select_rows',
  'butterbase_docs',
]);

export function isOperatorToolAllowed(name: string): boolean {
  return OPERATOR_TOOL_ALLOWLIST.has(name);
}

/**
 * Execute a gated tool exactly once per approval_id.
 *
 * The dedupe lives here rather than in the downstream tools because they have
 * no idempotency contract — Stripe supports keys, deploy_function does not,
 * and Composio/MCP tools have none. Enforcing at this layer makes it universal.
 *
 * Failures are NOT cached: a transient MCP error must remain retryable.
 */
export async function executeOnce(
  pool: pg.Pool,
  opts: { approvalId: string; name: string; args: unknown; jwt: string; orgId: string },
): Promise<McpCallResult> {
  if (!isOperatorToolAllowed(opts.name)) {
    return { ok: false, error: `tool "${opts.name}" is not permitted for the operator` };
  }

  const cached = await pool.query<{ result: McpCallResult }>(
    `SELECT result FROM dashboard_agent_tool_executions WHERE approval_id = $1`,
    [opts.approvalId],
  );
  if (cached.rows.length > 0) return cached.rows[0].result;

  const result = await callMcpTool(opts.name, opts.args, opts.jwt, opts.orgId);

  if (result.ok) {
    await pool.query(
      `INSERT INTO dashboard_agent_tool_executions (approval_id, result)
       VALUES ($1, $2) ON CONFLICT (approval_id) DO NOTHING`,
      [opts.approvalId, JSON.stringify(result)],
    );
  }

  return result;
}
