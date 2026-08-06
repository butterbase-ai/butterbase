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
 * DENY needs nothing from this module FOR THE PRE-EMPTED PATH. loop.ts pauses
 * BEFORE dispatch, so a denied approval never reached substrate at all: there
 * is no pending action to reject. That path stays exactly as the C2 fix left
 * it — synthesize a denial result, write the `role: 'tool'` row, clear
 * `pending_approval_id`.
 *
 * ── FIX E: the POST-DISPATCH case, which is a different shape ───────────────
 *
 * Everything above concerns a propose we PRE-EMPTED, because the capability is
 * on the static `SUBSTRATE_APPROVAL_REQUIRED_CAPABILITIES` mirror. That mirror
 * is the FLOOR, not the ceiling: substrate's policy engine also escalates at
 * PROPOSE time — a principle conflict returns requires_approval even for a
 * capability whose `default_policy` is 'auto'. Those calls get verdict 'allow',
 * dispatch, and come back `{ action_id, requires_approval: true }` with the
 * action parked in substrate's ledger. Nothing executed (substrate held the
 * line), but no dashboard approval existed either, so the work stalled where
 * the operator feed could not see it and the operator's own route to resolve it
 * (`approve`) is correctly denied to it.
 *
 * For that case the propose has ALREADY HAPPENED and the action already exists.
 * So resolution must call `approve(action_id)` ONLY and must never re-propose —
 * which is why the approval row created for it stores the APPROVE call, not the
 * propose (see `createSubstrateEscalationApproval` in approvals-store.ts). That
 * row flows through the ordinary `executeApprovedOperatorTool` path below,
 * where `isSubstratePropose` is false, so it is a single `executeOnce` of
 * `manage_substrate approve` and the bridging block is skipped entirely.
 *
 * DENY, for that case only, DOES need something: the substrate action is real
 * and sits in `proposed` forever if we walk away. `rejectEscalatedSubstrateAction`
 * below closes it out under the same human identity.
 */

import pg from 'pg';
import { callMcpTool, type McpCallResult } from './mcp-client.js';
import { executeOnce } from './tool-bridge.js';
import { principalMayExecute, orgIdArgIsForeign } from './operator-policy.js';
import {
  isValidSubstrateActionId,
  readSubstrateEscalationActionId,
  SUBSTRATE_ESCALATION_TOOL,
} from './approvals-store.js';

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

  // Carry the propose's explicit `org_id` through so the approve lands on the
  // same substrate the action was proposed into. This can no longer be a
  // CROSS-org target: `executeOnce` above refuses any `org_id` that is not
  // `opts.orgId`, so by the time we get here the value either equals our own
  // org or is absent. Re-checked below anyway, because this leg calls
  // `callMcpTool` directly rather than through `executeOnce`.
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

  // Defence in depth for the one raw `callMcpTool` on this path: an `org_id`
  // argument overrides the `x-organization-id` header, and this call runs on
  // the approving human's JWT, whose org membership may span more than
  // `opts.orgId`. Unreachable while `executeOnce`'s identical guard stands —
  // it is here so that this call site is safe on its own terms.
  if (orgIdArgIsForeign(approveArgs, opts.orgId)) {
    return {
      ok: false,
      error: 'substrate approve names an org_id outside this operator\'s organization',
    };
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

/**
 * FIX E, read side. Did this DISPATCHED operator tool call come back as a
 * substrate escalation — a propose that substrate parked in `proposed` pending
 * a human decision?
 *
 * Returns the action id from SUBSTRATE'S RESPONSE, or null. This is the ONLY
 * source `createSubstrateEscalationApproval` is ever given an action id from;
 * the model's own arguments are read here solely to answer "was this a
 * propose?", never to supply the id.
 *
 * Deliberately conservative — every not-sure answer is null, which leaves
 * today's behaviour (record the pending result as an ordinary tool result and
 * carry on) rather than raising an approval nobody asked for:
 *
 *   - not a `manage_substrate` propose            -> null
 *   - the MCP call failed, or the envelope is a
 *     tool-level error / unparseable              -> null
 *   - `requires_approval` is not exactly `true`   -> null (an 'auto' capability
 *                                                   executed, or a `replay: true`
 *                                                   of an action already past
 *                                                   `proposed`)
 *   - `action_id` missing or not a plausible id   -> null
 */
export function readSubstrateEscalation(
  name: string,
  args: unknown,
  result: unknown,
): string | null {
  if (!isSubstratePropose(name, args)) return null;
  const envelope = readMcpEnvelope(result);
  if (!envelope || envelope.isError) return null;
  const shape = (envelope.json ?? {}) as ProposeShape;
  if (shape.requires_approval !== true) return null;
  return isValidSubstrateActionId(shape.action_id) ? shape.action_id : null;
}

/**
 * FIX E, deny side. Close out the substrate action a DENIED escalation
 * approval refers to.
 *
 * THE DECISION, stated rather than left ambiguous: a denied escalation is
 * REJECTED IN SUBSTRATE. The action is real and already in `proposed`; leaving
 * it there would be exactly the invisible stall this fix exists to remove, just
 * moved one step later — the operator would keep rediscovering an action the
 * human has already refused, and substrate's ledger would disagree with the
 * dashboard about what was decided.
 *
 * `reject` is in OPERATOR_DENIED_SUBSTRATE_ACTIONS and stays there. This call
 * is made with `principal: 'human'` for the same reason the approve leg is: a
 * PERSON clicked deny. The agent's own tool surface still cannot reach it.
 *
 * BEST-EFFORT, and the tradeoff is deliberate. If substrate refuses the reject
 * (already resolved, transport failure), we do NOT block the denial: an
 * approval a human cannot deny is a wedge, and wedging the org's one operator
 * conversation is strictly worse than a stale `proposed` row. The failure is
 * returned so the caller can fold it into the tool result the model sees, which
 * makes the residue visible instead of silent.
 *
 * Runs through `executeOnce` on the approval id, so it inherits the principal
 * check, the cross-org guard and the advisory lock. That also means a
 * deny racing an approve cannot fire both calls: whichever executes first is
 * cached under this approval id and the loser is served that result, while
 * `resolveApproval`'s conditional UPDATE 409s it.
 */
export async function rejectEscalatedSubstrateAction(
  pool: pg.Pool,
  opts: {
    approvalId: string;
    approval: { toolName: string; toolArgs: unknown };
    reason?: string;
    jwt: string;
    orgId: string;
  },
): Promise<{ attempted: boolean; ok: boolean; error?: string }> {
  const actionId = readSubstrateEscalationActionId(opts.approval);
  if (!actionId) return { attempted: false, ok: true };

  // `reason` is required by the MCP tool and lands in substrate's audit trail.
  const reason =
    typeof opts.reason === 'string' && opts.reason.trim().length > 0
      ? opts.reason.trim()
      : 'Denied in the Butterbase operator approvals feed.';

  const call = await executeOnce(pool, {
    approvalId: opts.approvalId,
    name: SUBSTRATE_ESCALATION_TOOL,
    args: { action: 'reject', action_id: actionId, reason },
    jwt: opts.jwt,
    orgId: opts.orgId,
    principal: 'human',
  });

  if (!call.ok) return { attempted: true, ok: false, error: call.error };
  const envelope = readMcpEnvelope(call.result);
  if (envelope?.isError) return { attempted: true, ok: false, error: envelope.text };
  return { attempted: true, ok: true };
}
