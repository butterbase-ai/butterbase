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
 * PostgreSQL rejects NUL (U+0000) inside JSONB. Without this, a tool result
 * containing one makes the INSERT throw *after* the tool has already fired:
 * nothing is recorded and a retry re-executes the side effect. Strip NULs from
 * keys and values so a successful execution is always recorded. Those stripped
 * bytes are the only way a replayed result can differ from a fresh one.
 */
function stripNulls(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\u0000/g, '');
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.replace(/\u0000/g, '')] = stripNulls(v);
    }
    return out;
  }
  return value;
}

/**
 * Execute a gated tool exactly once per approval_id.
 *
 * The dedupe lives here rather than in the downstream tools because they have
 * no idempotency contract — Stripe supports keys, deploy_function does not,
 * and Composio/MCP tools have none. Enforcing at this layer makes it universal.
 *
 * The whole check-execute-record sequence runs in one transaction on a single
 * client, guarded by a pg_advisory_xact_lock keyed on the approval_id. Without
 * it, two concurrent callers both miss the cache SELECT and both call the tool;
 * ON CONFLICT DO NOTHING would then protect the ledger row but not the side
 * effect, so one approved refund or email could go out twice. A concurrent
 * caller now blocks on the lock and, once through, reads the cached result.
 *
 * Accepted tradeoff: a pool connection is held for the duration of the MCP
 * call, and a crash mid-call degrades to at-least-once. Deliberately no
 * stale-claim timeout or other recovery machinery.
 *
 * Failures are NOT cached: a transient MCP error must remain retryable. On a
 * failed result no row is written and the lock releases at COMMIT, leaving the
 * approval open for a retry.
 */
export async function executeOnce(
  pool: pg.Pool,
  opts: { approvalId: string; name: string; args: unknown; jwt: string; orgId: string },
): Promise<McpCallResult> {
  // Ahead of every path that can reach callMcpTool, and ahead of touching the
  // database at all: a non-allowlisted tool never takes the lock and can never
  // be replayed out of the cache.
  if (!isOperatorToolAllowed(opts.name)) {
    return { ok: false, error: `tool "${opts.name}" is not permitted for the operator` };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serialise every caller for this approval_id. hashtextextended is stable
    // across processes and derived only from the approval id. Held until
    // COMMIT/ROLLBACK below.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [opts.approvalId]);

    const cached = await client.query<{ result: McpCallResult }>(
      `SELECT result FROM dashboard_agent_tool_executions WHERE approval_id = $1`,
      [opts.approvalId],
    );
    if (cached.rows.length > 0) {
      await client.query('COMMIT');
      return cached.rows[0].result;
    }

    const result = await callMcpTool(opts.name, opts.args, opts.jwt, opts.orgId);

    if (result.ok) {
      await client.query(
        `INSERT INTO dashboard_agent_tool_executions (approval_id, result)
         VALUES ($1, $2) ON CONFLICT (approval_id) DO NOTHING`,
        [opts.approvalId, JSON.stringify(stripNulls(result))],
      );
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
