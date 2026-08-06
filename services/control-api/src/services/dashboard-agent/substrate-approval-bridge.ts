/**
 * Substrate approval bridge (C2b).
 *
 * THE BUG THIS FIXES — a double approval, and a turn that never sees a result.
 *
 * The operator calls `manage_substrate` with `action: 'propose'` and a
 * capability whose substrate `default_policy` is 'approval_required'.
 * `operatorPolicyFor` returns 'approval', so loop.ts pauses the turn BEFORE
 * dispatching and raises a dashboard_agent approval. A human approves it in
 * the operator feed, and `resolveOperatorApproval` replays the original call
 * through `executeOnce`. Substrate then does exactly what it is supposed to
 * do: it applies its OWN policy engine, returns
 * `{ action_id, requires_approval: true }`, and leaves the action in
 * `proposed`. Nothing executes. The human approved at our layer and is now
 * expected to approve a second time in substrate's, and the tool result the
 * turn resumes with says "pending" rather than what happened.
 *
 * THE FIX — bridge our approval to substrate's NATIVE one. After the propose,
 * if substrate reports a pending action, call `action: 'approve'` with that
 * action_id under the SAME human identity, and hand the turn the executed
 * result instead of the pending one.
 *
 * WHAT THIS IS NOT:
 *
 *  - It is NOT `dangerously_skip_approval`. `substrate-core/src/policy/
 *    policy-engine.ts` only honours that flag for a non-app, non-rule proposer
 *    on a `yolo_eligible` capability. Several of the eight gated capabilities —
 *    `amend_principle` among them — are never yolo_eligible, so a skip-based
 *    design would silently return requires_approval again on exactly the most
 *    sensitive ones. The flag is never set here and must never be added.
 *
 *  - It is NOT permission for the operator to approve. `approve` and `reject`
 *    stay in OPERATOR_DENIED_SUBSTRATE_ACTIONS. The call below is made with
 *    `principal: 'human'` because a PERSON clicked approve in the feed; the
 *    agent's own tool surface still cannot reach it. Removing `approve` from
 *    the denied set to "simplify" this restores agent self-approval — propose
 *    a gated capability, approve your own action_id, forge an
 *    `approved_by_kind = 'human'` ledger row. Do not.
 *
 * DENY needs nothing from this module. loop.ts pauses BEFORE dispatch, so a
 * denied approval never reached substrate at all: there is no pending action
 * to reject. The deny path stays exactly as the C2 fix left it — synthesize a
 * denial result, write the `role: 'tool'` row, clear `pending_approval_id`.
 */

import pg from 'pg';
import { callMcpTool, type McpCallResult } from './mcp-client.js';
import { executeOnce } from './tool-bridge.js';
import { principalMayExecute } from './operator-policy.js';

/**
 * `callMcpTool` returns the raw JSON-RPC `result`, which for a tools/call is
 * an MCP CallToolResult: `{ content: [{ type: 'text', text }], isError? }`.
 * manage_substrate JSON-encodes its payload into that single text block, and
 * on an upstream HTTP error returns the error body the same way with
 * `isError: true` — which `callMcpTool` still reports as `ok: true`, because
 * the JSON-RPC call itself succeeded. So a tool-level failure is only visible
 * here, and both call sites below have to check it.
 */
type McpEnvelope = { json: unknown; text: string; isError: boolean };

function readMcpEnvelope(result: unknown): McpEnvelope | null {
  if (!result || typeof result !== 'object') return null;
  const envelope = result as { content?: unknown; isError?: unknown };
  if (!Array.isArray(envelope.content)) return null;
  const block = envelope.content.find(
    (c): c is { type: string; text: string } =>
      !!c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string',
  );
  if (!block) return null;
  let json: unknown;
  try {
    json = JSON.parse(block.text);
  } catch {
    json = undefined;
  }
  return { json, text: block.text, isError: envelope.isError === true };
}

/** Is this the call the bridge exists for — a manage_substrate propose? */
function isSubstratePropose(name: string, args: unknown): args is Record<string, unknown> {
  if (name !== 'manage_substrate') return false;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  return (args as { action?: unknown }).action === 'propose';
}

/**
 * The subset of `ProposeResult` (cloud/packages/substrate-core/src/types.ts)
 * the bridge reads. Deliberately re-declared rather than imported: substrate-
 * core lives in the internal monorepo and is not a dependency of this OSS
 * package. Only two fields are load-bearing and both are checked defensively.
 */
type ProposeShape = { action_id?: unknown; requires_approval?: unknown };

/**
 * Execute an approved operator tool call, bridging substrate's native
 * approval when the call was a gated propose.
 *
 * This is the `execute` callback for `resolveOperatorApproval`. It is NOT a
 * general-purpose executor: it only ever runs against an approval a human
 * just resolved, which is why `principal: 'human'` is correct throughout.
 *
 * ── Idempotency: two layers, and how they compose ────────────────────────
 *
 * Layer 1 — `executeOnce`'s advisory-lock transaction, keyed on approval_id.
 * It serialises concurrent resolvers and caches a SUCCESSFUL result, so the
 * propose leg fires at most once per approval under normal operation, and a
 * retry after any later failure is served from that cache rather than
 * re-proposing. That is what makes the two-leg sequence below safely
 * re-drivable: retry resumes at the approve, it does not re-propose.
 *
 * Layer 2 — substrate's own `idempotency_key`. `proposeAction` dedupes on
 * (org, key) with no TTL and returns the prior action's verdict and result
 * with `replay: true`, and critically `requires_approval: row.status ===
 * 'proposed'` — so a replay of an action that already executed reports false
 * and this bridge correctly makes no second call. The key is injected below,
 * defaulting to the approval id, because layer 1 has one hole layer 2 closes:
 * if the MCP call succeeds but the process dies before COMMIT, no cache row
 * exists and a retry WOULD re-propose, creating a second pending ledger
 * action. With the key, that retry deduplicates against the first action and
 * the bridge approves the one that already exists.
 *
 * An agent-supplied idempotency_key is never overwritten — it is the agent's
 * own dedupe contract, and it dedupes at least as strongly as ours.
 *
 * The approve leg is NOT wrapped in `executeOnce`:
 * `dashboard_agent_tool_executions.approval_id` is a UUID primary key with a
 * foreign key to `dashboard_agent_approvals(id)`, so a derived second cache
 * key is not representable. It does not need one — `approveAction` takes
 * `FOR UPDATE` on the ledger row and throws unless the status is still
 * `proposed`, so substrate itself makes approval at-most-once.
 *
 * RESIDUAL WINDOW, stated rather than papered over: if the approve executes
 * in substrate but its response is lost (timeout, crash), a retry re-runs the
 * approve against an action that is no longer `proposed`, substrate throws,
 * and this returns a failure — leaving the dashboard approval pending. The
 * side effect is NOT duplicated (that is the guarantee that matters), and the
 * conversation is not wedged: no partial history is written, so the operator's
 * next wake is the same clean no-op skip it already is, and denying the
 * approval remains available to close it out. But an approve stuck this way
 * will keep failing until someone reconciles it against the ledger.
 */
export async function executeApprovedOperatorTool(
  pool: pg.Pool,
  opts: {
    approvalId: string;
    name: string;
    args: unknown;
    jwt: string;
    orgId: string;
  },
): Promise<McpCallResult> {
  // Bound to a const so the type predicate's narrowing survives to the uses
  // below (TypeScript does not preserve aliased narrowing through a mutable
  // property access like `opts.args`).
  const rawArgs: unknown = opts.args;
  const bridging = isSubstratePropose(opts.name, rawArgs);

  const args = bridging && rawArgs.idempotency_key === undefined
    ? { ...rawArgs, idempotency_key: opts.approvalId }
    : rawArgs;

  const proposed = await executeOnce(pool, {
    approvalId: opts.approvalId,
    name: opts.name,
    args,
    jwt: opts.jwt,
    orgId: opts.orgId,
    principal: 'human',
  });

  // Not a gated substrate propose (a rule mutation, manage_integrations, …),
  // or the call failed outright: nothing to bridge.
  if (!bridging || !proposed.ok) return proposed;

  const envelope = readMcpEnvelope(proposed.result);
  // Unreadable or tool-level error. Return it unchanged — the turn should see
  // substrate's own error, and there is no action_id to approve.
  if (!envelope || envelope.isError) return proposed;

  const shape = (envelope.json ?? {}) as ProposeShape;

  // `requires_approval: false` means substrate already executed it: an 'auto'
  // capability, or a replay of an action that is past `proposed`. Making a
  // second call here would approve something that no longer needs approving.
  if (shape.requires_approval !== true) return proposed;

  const actionId = typeof shape.action_id === 'string' ? shape.action_id : '';
  if (!actionId) {
    return {
      ok: false,
      error: 'substrate reported requires_approval with no action_id; cannot complete the approval',
    };
  }

  // Preserve the propose's cross-org target so the approve lands on the same
  // substrate the action was proposed into.
  const targetOrg = rawArgs.org_id;
  const approveArgs: Record<string, unknown> = {
    action: 'approve',
    action_id: actionId,
    ...(typeof targetOrg === 'string' && targetOrg ? { org_id: targetOrg } : {}),
  };

  // Defence in depth, and a deliberate statement of WHICH principal is
  // allowed to do this. `principalMayExecute('operator', …)` would return
  // false here — `approve` is denied to the agent. It is a human's click that
  // authorises this call, so the principal is 'human', and the tool-level
  // allowlist still applies to them.
  if (!principalMayExecute('human', 'manage_substrate', approveArgs)) {
    return { ok: false, error: 'substrate approve is not permitted for the human' };
  }

  const approved = await callMcpTool('manage_substrate', approveArgs, opts.jwt, opts.orgId);
  if (!approved.ok) {
    return { ok: false, error: `substrate approve failed: ${approved.error ?? 'unknown error'}` };
  }

  const approvedEnvelope = readMcpEnvelope(approved.result);
  if (approvedEnvelope?.isError) {
    return { ok: false, error: `substrate approve failed: ${approvedEnvelope.text}` };
  }

  // The turn resumes with the EXECUTED outcome, not the pending propose.
  return approved;
}
