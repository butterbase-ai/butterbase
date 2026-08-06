import pg from 'pg';
import { callMcpTool, type McpCallResult } from './mcp-client.js';
import { principalMayExecute, orgIdArgIsForeign, type OperatorPrincipal } from './operator-policy.js';

/**
 * The allowlist and the gating rules live in ONE table, in operator-policy.ts.
 * They used to be two independent lists here and in tool-catalog.ts, and they
 * drifted until their intersection was empty. Re-exported for existing callers;
 * `operator-policy.ts` is the source of truth.
 */
export {
  OPERATOR_TOOL_ALLOWLIST,
  isOperatorToolAllowed,
  operatorRequiresApproval,
  operatorPolicyFor,
  operatorPolicyForOrg,
  orgIdArgIsForeign,
  principalMayExecute,
  type OperatorPolicy,
  type OperatorPrincipal,
} from './operator-policy.js';

/**
 * PostgreSQL rejects NUL (U+0000) inside JSONB. Without this, a tool result
 * containing one makes the INSERT throw *after* the tool has already fired:
 * nothing is recorded and a retry re-executes the side effect. Strip NULs from
 * keys and values so a successful execution is always recorded. Those stripped
 * bytes are the only way a replayed result can differ from a fresh one.
 *
 * Deliberately applied to the CACHED copy only — the executing caller still
 * receives the raw result. That means every OTHER place which persists a tool
 * result to JSONB carries the same constraint and must sanitise at its own
 * write; the shared implementation lives in store.ts so there is one copy.
 */
import { stripJsonbNulls as stripNulls } from './store.js';

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
 *
 * ── PRECONDITION, load-bearing: ONE approval id means ONE distinct call ────
 *
 * The cache is keyed on `approval_id` ALONE. `dashboard_agent_tool_executions.
 * approval_id` is a UUID PRIMARY KEY with a foreign key to
 * `dashboard_agent_approvals(id)`, so the key cannot be composite or derived
 * without a schema change, and the stored row carries nothing that identifies
 * WHICH call produced it.
 *
 * That makes the key sound only while a given approval id is executed from
 * exactly one call site with one set of arguments. A SECOND call under the
 * same approval — a different tool, a different action, different args — does
 * not duplicate a side effect (the lock and the cache still prevent that), but
 * it makes the loser of a race read back the WINNER'S envelope and report
 * success for a call it never made. That is an audit-integrity defect: the
 * dashboard's record can contradict what actually happened downstream. It
 * shipped once, as a deny going through here under the same approval id as the
 * approve (I-1); see `rejectEscalatedSubstrateAction` in
 * substrate-approval-bridge.ts, which no longer does.
 *
 * So: DO NOT add a second `executeOnce` call site under an approval id that
 * another site already uses. If a second distinct call genuinely needs
 * exactly-once caching, that needs a composite/derived key and therefore a
 * migration in BOTH streams (`db/control-plane/` and
 * `submodules/butterbase-oss/services/control-api/migrations/`), not key reuse.
 * A downstream operation that is already at-most-once on its own terms — as
 * substrate's `approveAction`/`rejectAction` are, via `FOR UPDATE` plus a
 * status check — needs no key here at all.
 */
export async function executeOnce(
  pool: pg.Pool,
  opts: {
    approvalId: string;
    name: string;
    args: unknown;
    jwt: string;
    orgId: string;
    /**
     * WHO is calling. Required, deliberately not defaulted: a new call site
     * must be forced to state this rather than inherit whichever answer
     * happened to be safe at the one site that existed when it was written.
     *
     *  'operator' — the unattended agent itself. Gets the full operator policy
     *    table, including the manage_substrate action denials.
     *  'human'    — the server acting on a person's click in the operator
     *    approvals feed. The agent-specific action denials do not apply; the
     *    tool-level allowlist still does. This is what lets the approval
     *    bridge call substrate's native approve(action_id), which `approve`
     *    being denied to the OPERATOR would otherwise block.
     */
    principal: OperatorPrincipal;
  },
): Promise<McpCallResult> {
  // Ahead of every path that can reach callMcpTool, and ahead of touching the
  // database at all: a tool this principal may not call never takes the lock
  // and can never be replayed out of the cache. Consults the unified policy
  // table rather than a local list. A verdict of 'approval' is executable here
  // by construction — executeOnce only ever runs against an approval a human
  // already resolved.
  //
  // Do NOT collapse this back to a principal-free check by deleting `approve`
  // from OPERATOR_DENIED_SUBSTRATE_ACTIONS: that silently restores agent
  // self-approval (propose a gated capability, then approve your own
  // action_id, stamping approved_by_kind='human'). See principalMayExecute.
  if (!principalMayExecute(opts.principal, opts.name, opts.args)) {
    return {
      ok: false,
      error: `tool "${opts.name}" is not permitted for the ${opts.principal}`,
    };
  }

  /**
   * CROSS-ORG GUARD, and this is the path that actually needed it.
   *
   * `opts.orgId` becomes the `x-organization-id` header, but an `org_id`
   * ARGUMENT overrides it inside `manage_substrate`. On the approval replay
   * `opts.jwt` is the APPROVING HUMAN's bearer token, and for JWT auth
   * substrate resolves the org against `organization_members` — so an operator
   * in org A could store `{action:'propose', …, org_id:'<org B>'}` in an
   * approval row and one click from an org A member who also belongs to org B
   * would write into org B's substrate. The operator's own turn was contained
   * only by its credential being org-bound; here nothing contained it.
   *
   * Placed alongside the principal check, ahead of `pool.connect()`: a refused
   * call never takes the advisory lock, never writes a `tool_executions` row,
   * and can never be served back out of the cache — the exactly-once guarantee
   * below is untouched, it simply never applies to a call we refuse.
   *
   * Note this is NOT principal-conditional. There is no principal for which
   * pointing an operator approval at another org is legitimate.
   */
  if (orgIdArgIsForeign(opts.args, opts.orgId)) {
    return {
      ok: false,
      error: `tool "${opts.name}" names an org_id outside this operator's organization`,
    };
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
