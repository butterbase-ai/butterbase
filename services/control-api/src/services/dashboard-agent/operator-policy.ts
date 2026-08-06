/**
 * Operator policy — the SINGLE source of truth for what the autonomous
 * operator may call and what must pause for a human.
 *
 * This module exists because the two questions used to be answered by two
 * independent lists that drifted apart until their intersection was empty:
 * a server-side allowlist in tool-bridge.ts, and `sensitivityFor` in
 * tool-catalog.ts. Every approval the operator could ever create named a tool
 * the bridge refused to run. Do not reintroduce a second table — ask this
 * module.
 *
 * Two distinct concerns, deliberately kept apart:
 *
 *  - `sensitivityFor` (tool-catalog.ts) governs the HUMAN assistant, where a
 *    person is watching every tool call. Its tiers are a UX affordance. It is
 *    not consulted here and must not be changed to serve the operator.
 *
 *  - `operatorPolicyFor` (here) governs the HEADLESS operator, which runs
 *    unattended holding an org service key. Nobody is watching, so the answer
 *    has to be structural.
 */

import { OPERATOR_SCRATCHPAD_TOOL, OPERATOR_SANDBOX_CODE_TOOL } from './tool-catalog.js';

export type OperatorPolicy = 'allow' | 'approval' | 'deny';

/**
 * Tools the operator dispatches IN-PROCESS in the loop rather than forwarding
 * to the MCP server. There is no MCP tool by these names.
 *
 * They still get a verdict from the one table below (they are spread into
 * OPERATOR_TOOL_ALLOWLIST), so the dispatch-site control governs them exactly
 * like any other tool. What the set adds is the two places a LOCAL name must
 * NOT be treated as an MCP name: `principalMayExecute` (the approval-replay
 * path, which ends in `callMcpTool`) and the loop's internal `turnMcp` wrapper.
 */
export const OPERATOR_LOCAL_TOOLS: ReadonlySet<string> = new Set([
  OPERATOR_SCRATCHPAD_TOOL,
  OPERATOR_SANDBOX_CODE_TOOL,
]);

/**
 * Tools the operator may call at all. Everything else is `deny`.
 *
 * manage_billing, manage_app and manage_repo are deliberately absent: nothing
 * in v1 lets the operator spend money or delete infrastructure.
 *
 * manage_integrations is present and UNGATED. That is a deliberately accepted
 * risk, recorded 2026-08-05 and re-confirmed by the user 2026-08-06: it is the
 * real outbound-email path, so the operator can send mail with no human in the
 * loop. Do not silently change this — revisit the decision instead.
 *
 * `update_operator_scratchpad` is 'allow', ungated, and deliberately so. It
 * writes ONE control-plane row — the operator's own working notes for its own
 * org — and reaches nothing else: no MCP call, no tenant data, no customer.
 * The target org is the trusted sentinel org, not an argument, so there is no
 * cross-org shape to gate. Crucially the row it writes is NEVER read by any
 * control: see the RULE on `dashboard_agent_operator_scratchpad`
 * (operator-scratchpad-store.ts) — the scratchpad is model-written, so if any
 * verdict in this module ever consulted it the agent would be writing its own
 * permissions. Gating the write would not fix that; not reading it does.
 *
 * `run_sandbox_code` is likewise 'allow', ungated. What it does NOT reach is
 * narrower than an earlier version of this comment claimed: the MicroVM
 * (E2B/Alibaba FC Agent Sandbox) holds no CREDENTIAL of any kind — not the
 * operator's service key, not an MCP session, not a JWT of any shape.
 * `createSandbox` (sandbox-provider.ts) passes only `apiKey`/`apiUrl`/
 * `domain`/`timeoutMs` to `Sandbox.create` — no `envs`, no secret is ever
 * placed inside the VM. That part is verified and true.
 *
 * What is NOT true, and must not be claimed here again: that the sandbox has
 * no network reachability. It does — the stock `code-interpreter-v1` template
 * has ordinary outbound internet access (that is how `pip install` works
 * inside it), and nothing in `sandbox-provider.ts` restricts egress. So an
 * operator turn that first calls `select_rows` (or any other allowlisted
 * read) and then calls `run_sandbox_code` with code that POSTs the result to
 * an attacker-controlled URL can exfiltrate customer data with no gate, no
 * approval, and no audit trail of the exfiltration itself — only of the read
 * that preceded it.
 *
 * The verdict stays 'allow' anyway, but for a narrower reason than "nothing
 * to reach": this adds NO NEW CAPABILITY CLASS beyond what `manage_integrations`
 * already accepts above. An operator that can already call `manage_integrations`
 * with attacker-supplied content (the real outbound-email path, deliberately
 * ungated, accepted risk recorded 2026-08-05/06) can already exfiltrate
 * arbitrary data outbound with no human in the loop; `run_sandbox_code` is a
 * second outbound channel with the same shape of risk, not a new one. If that
 * accepted-risk decision is ever revisited, this verdict must be revisited
 * with it — do not treat them as independent. The 30s synchronous-execution
 * cap and `SandboxRunner`'s kill-in-finally bound CPU/wall-clock abuse, but do
 * nothing to bound this — record that honestly rather than implying they do.
 *
 * Gating it structurally cannot be done here anyway: whether it is even
 * offered on a given turn is decided by `codeExecutor` presence in the loop
 * (see `OPERATOR_SANDBOX_CODE_TOOL`'s doc comment in tool-catalog.ts), which
 * is orthogonal to this allow/approval/deny table and is the actual
 * safety-critical control for this tool — NOT this verdict.
 *
 * Restricting egress (e.g. an allowlist, a proxy, or a template with no
 * network at all) would close this properly, but that is a template/runtime
 * concern for a later stage (Stage C's custom container), not something to
 * attempt here by editing `sandbox-provider.ts`'s config plumbing.
 */
export const OPERATOR_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'manage_substrate',
  'manage_integrations',
  'manage_people',
  'query_audit_logs',
  'select_rows',
  'butterbase_docs',
  ...OPERATOR_LOCAL_TOOLS,
]);

/**
 * Substrate capabilities whose `default_policy` is 'approval_required'.
 *
 * These are mirrored from cloud/packages/substrate-core/src/capabilities/*.ts.
 * That package lives in the internal monorepo and is not a dependency of this
 * OSS package, so it cannot be imported across the repo boundary. The mirror is
 * guarded by a drift test (__tests__/operator-policy.test.ts) that reads the
 * real capability sources whenever the internal checkout is present and fails
 * if the two lists disagree.
 *
 * Note this is the FLOOR, not the ceiling: substrate's policy engine can also
 * escalate an otherwise-'auto' capability to requires_approval (e.g. a
 * principle conflict). Substrate remains the enforcer — a propose it gates
 * returns a pending action and does not execute. This list only tells the
 * operator loop when to expect that and pause the turn.
 */
export const SUBSTRATE_APPROVAL_REQUIRED_CAPABILITIES: ReadonlySet<string> = new Set([
  'send_email_draft',
  'delete_entity',
  'merge_entities',
  'record_principle',
  'amend_principle',
  'retire_principle',
  'supersede_decision',
  'bulk_revert_actions',
]);

/**
 * `manage_substrate` actions the operator may never invoke, at any tier.
 *
 * GOVERNING PRINCIPLE: an agent must never be able to weaken the controls that
 * govern it. These are deliberately NOT gateable-with-approval — a gate the
 * agent can propose its way through is not a control, it is a speed bump.
 *
 *  - set_yolo: `cloud/overlays/substrate/routes/settings.ts` makes this a bare
 *    org-wide `UPDATE substrate.organizations SET yolo_mode`, and
 *    `substrate-core/src/policy/policy-engine.ts` treats
 *    `organization_yolo_mode` as an implicit skip flag that auto-approves any
 *    `approval_required` capability which is `yolo_eligible` for a non-app,
 *    non-rule proposer. `send_email_draft` is exactly that: approval_required
 *    AND yolo_eligible. So an unattended operator could switch substrate's own
 *    gate off, org-wide, for the one gated capability that reaches a customer —
 *    and the flip would apply to the human assistant and every other proposer
 *    too. That defeats the premise the whole design rests on.
 *
 *  - resolve_policy_conflict: its own doc string says "Record how a HUMAN
 *    disposed of a conflict", and `cloud/overlays/substrate/routes/policy.ts`
 *    writes `resolved_by_entity_id` from the proposer. It is not an execution
 *    bypass (it does not approve the blocked action), but an unattended agent
 *    closing its own principle conflicts corrupts that audit record.
 *
 *  - approve: THE one that makes every other gate hollow.
 *    `substrate-core/src/action-executor.ts::approveAction` (L271-306) checks
 *    only that the action belongs to the caller's org (L292) and is still in
 *    `proposed` state (L295). There is NO self-approval restriction — the
 *    proposer and the approver are never compared. It then executes the
 *    capability and stamps `approved_by_kind = 'human'` (L306).
 *    So without this denial the operator could propose `send_email_draft`, get
 *    the correct 'approval' verdict from this very table, and then call
 *    `approve` on its own action_id — executing the send and leaving a ledger
 *    row claiming a human authorised it. That is exactly the failure this
 *    module warns about: a gate the agent can propose its way through is not a
 *    control. It also reduced the `set_yolo` denial to a partial mitigation,
 *    since the agent would no longer need to switch the gate off — it could
 *    simply satisfy it itself.
 *
 *  - reject: lower severity, since declining its own proposal is not an
 *    execution path. Denied anyway because `rejectAction` (L364-391) stamps the
 *    same human-decision fields, including `approved_by_kind = 'human'` (L391).
 *    Denying only `approve` would leave the audit record forgeable in one
 *    direction, which is not a coherent place to stop.
 *
 * Resolution of a gated operator proposal happens through the operator
 * approvals feed: a human approves there, and the bridge calls substrate's
 * native approve under a HUMAN identity. This denial is on the OPERATOR'S OWN
 * TOOL SURFACE, not a statement that the approve endpoint is off limits to
 * everyone.
 *
 * DO NOT "fix" a blocked bridge call by deleting `approve` from this set. That
 * restores agent self-approval and makes the whole governance model
 * decorative. The distinction is carried by the required `principal` argument
 * on `executeOnce` (tool-bridge.ts) and enforced by `principalMayExecute`
 * below: `'operator'` gets this table in full, `'human'` gets the tool-level
 * allowlist only.
 *
 * This is an OPERATOR-ONLY restriction. The human assistant keeps full access
 * to all four actions, and all four stay documented in the shared tool catalog.
 */
export const OPERATOR_DENIED_SUBSTRATE_ACTIONS: ReadonlySet<string> = new Set([
  'set_yolo',
  'resolve_policy_conflict',
  'approve',
  'reject',
]);

/**
 * `manage_substrate` actions the operator may invoke only with a human
 * decision. Same family of concern as the denied set above — an agent must not
 * weaken the controls that govern it — but a different answer, because unlike
 * `set_yolo` these are legitimate things for an operator to want.
 *
 * Attention rules are the OVERSIGHT mechanism, and the outbox is the queue of
 * work already committed to. An agent that can silently delete the rule
 * watching it, disable it, or cancel queued outbound work has weakened its own
 * oversight. `create_rule` is here for the mirror-image reason: it lets the
 * operator author a rule that proposes on its behalf, on a cron, unattended.
 *
 * Note precisely what that last one is and is not. It is NOT an approval
 * bypass: `substrate-core/src/policy/policy-engine.ts` returns
 * requires_approval for `source_rule_id !== null` on BOTH override branches —
 * "rule proposer cannot skip approval" (L52-53) and "rule proposer cannot use
 * yolo_mode" (L65-66) — so a rule cannot propose past a gate the operator
 * itself could not. What it creates is unattended automation, and a human
 * decision is exactly the right control for that.
 *
 * `update_rule` and `retry_outbox` are deliberately absent: this set is the
 * five actions the plan author ruled on (2026-08-06), not a category I widened
 * on my own. Revisit them explicitly if the surface changes.
 *
 * SECOND GATING SOURCE — deliberately explicit. Unlike the propose rule below,
 * these are not substrate-capability proposals, so their gate cannot be derived
 * from `default_policy`. That makes two gating RULES inside this one table.
 * That is fine and intended: the original bug was two independent LISTS in two
 * modules that drifted until their intersection was empty, not two rules in one
 * place. Both rules live here, both are named, and the precedence between them
 * is fixed below.
 */
export const OPERATOR_APPROVAL_SUBSTRATE_ACTIONS: ReadonlySet<string> = new Set([
  'create_rule',
  'delete_rule',
  'disable_rule',
  'enable_rule',
  'cancel_outbox',
]);

/**
 * `manage_substrate` actions the operator may invoke freely — the third and
 * last verdict, written down rather than left to fall through the floor.
 *
 * This set changes NO runtime behaviour: `operatorPolicyFor` already returns
 * 'allow' for anything not denied or gated. It exists so that every action the
 * MCP tool advertises has an explicit, deliberate verdict somewhere in this
 * module, and so that a test can prove it (see the enumeration guard in
 * __tests__/operator-policy.test.ts, which reads the `action` z.enum out of
 * cloud/overlays/substrate/mcp-tools/manage-substrate.ts and fails on any
 * action that appears in none of these sets).
 *
 * That guard is the answer to how `approve` stayed on the operator's surface
 * through three review rounds: the capability surface grew and the policy
 * table did not know about it. A new substrate action must now be classified
 * here — allow, approval, or deny — or the guard fails.
 *
 * `propose` is deliberately absent: its verdict is not fixed, it is derived
 * per-capability from SUBSTRATE_APPROVAL_REQUIRED_CAPABILITIES.
 */
export const OPERATOR_ALLOWED_SUBSTRATE_ACTIONS: ReadonlySet<string> = new Set([
  // provisioning — idempotent creation of the org's own substrate self-entity
  'provision',
  // ledger reads
  'list_actions',
  'get_action',
  // entities
  'find_entities',
  'get_entity',
  // source artifacts
  'list_source_artifacts',
  'get_source_artifact',
  // memory
  'search_memory',
  'list_memory',
  // outbox — reads, plus retry (re-sends work a human already authorised;
  // cancel_outbox is gated instead, see OPERATOR_APPROVAL_SUBSTRATE_ACTIONS)
  'list_outbox',
  'retry_outbox',
  // attention rules — reads, plus update_rule (see the note on the approval
  // set: the plan author named five mutations, update_rule was not one)
  'list_rules',
  'get_rule',
  'update_rule',
  'list_rule_firings',
  // snapshots & settings reads
  'snapshots',
  'get_settings',
  // policy surface reads
  'list_capabilities',
  'list_principles',
  'get_principle',
  'list_policy_conflicts',
  'get_policy_conflict',
]);

/** Sentinel: args were supplied but could not be understood. Fails closed. */
const UNREADABLE = Symbol('unreadable-args');

/**
 * Coerce tool args to a plain object.
 *
 * A security-critical deny table must not depend on somebody else normalising
 * its input first. The MCP tool's `z.enum` would reject a mis-cased or padded
 * action, and both current call sites pass parsed objects — but "not
 * exploitable today because of a downstream check" is not a property this
 * module should rely on. So:
 *
 *   - absent args (undefined/null)   -> {}   (no action named; nothing to deny)
 *   - a plain object                 -> itself
 *   - a JSON string encoding an object -> parsed
 *   - anything else (unparseable string, JSON array/scalar/null, a non-object)
 *                                    -> UNREADABLE, which fails closed
 */
function coerceArgs(args: unknown): Record<string, unknown> | typeof UNREADABLE {
  if (args === undefined || args === null) return {};
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return UNREADABLE;
    }
    return UNREADABLE;
  }
  if (typeof args !== 'object' || Array.isArray(args)) return UNREADABLE;
  return args as Record<string, unknown>;
}

/**
 * Read and normalise an action-like field: trim surrounding whitespace and
 * lower-case, then exact-match against the tables. Substrate action names are
 * all lower-case with no padding, so this only ever widens the deny/approval
 * nets toward the tables — it cannot let a denied action through, and it does
 * not match on prefixes (`set_yolo_mode` and `approve_all` stay distinct from
 * `set_yolo` and `approve`).
 *
 * Returns UNREADABLE when the field is present but not a string, so a crafted
 * `{action: {toString(){…}}}` fails closed instead of falling through.
 */
function readAction(args: Record<string, unknown>): string | null | typeof UNREADABLE {
  if (!('action' in args)) return null;
  const value = args.action;
  if (value === undefined) return null;
  if (typeof value !== 'string') return UNREADABLE;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function readStringField(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : null;
}

/**
 * CROSS-ORG GUARD. Does this call's `org_id` ARGUMENT point somewhere other
 * than the organization the caller is bound to?
 *
 * `callMcpTool` sets `x-organization-id` from the caller's own org, but
 * `manage_substrate` also accepts an explicit `org_id` argument and forwards
 * it as that same header — so the argument OVERRIDES the header. Nothing in
 * the verdict tables above ever looked at it.
 *
 * On the operator's own turn that was contained only by an external property:
 * the stored credential is an org-bound service key, so a foreign `org_id`
 * 403s at the MCP server. That is a property of the credential, not of this
 * code. On the APPROVAL REPLAY it was not contained at all — the replay runs
 * on the approving human's JWT, and for JWT auth substrate resolves the org
 * against `organization_members`. An operator in org A could therefore propose
 * `{action:'propose', capability:'send_email_draft', org_id:'<org B>'}`, and
 * one click from an org A member who also belongs to org B would write into
 * org B's substrate.
 *
 * FAILS CLOSED, in the same shape as `coerceArgs`/`readAction` above:
 *
 *   - args unreadable                 -> foreign. We cannot prove there is no
 *                                        `org_id` in there, so we refuse.
 *   - `org_id` absent or undefined    -> NOT foreign. The header already
 *                                        carries the right org; this is the
 *                                        normal, correct call shape.
 *   - `org_id` present, not a string  -> foreign (null, numbers, objects with
 *                                        a crafted `toString`).
 *   - `org_id` a string               -> trimmed + lower-cased on BOTH sides,
 *                                        then exact-matched. Same precedent as
 *                                        `readAction`: normalising can only
 *                                        widen the refusal net toward equality,
 *                                        never let a different org through, and
 *                                        it does not match on prefixes.
 *   - `org_id` blank after trimming   -> NOT foreign. An empty string is falsy
 *                                        downstream and forwards no header
 *                                        override, so it is the absent case.
 *   - caller's own org unknown/blank  -> foreign whenever an `org_id` is
 *                                        present. With nothing to compare
 *                                        against we cannot authorise a target.
 *
 * Only the TOP-LEVEL `org_id` key is inspected — that is the only field any
 * allowlisted tool turns into `x-organization-id`. Deliberately not widened to
 * `organization_id`, which is an ordinary column name that `select_rows` and
 * `manage_people` may legitimately carry in their arguments.
 */
export function orgIdArgIsForeign(args: unknown, ownOrgId: string | null | undefined): boolean {
  const parsed = coerceArgs(args);
  if (parsed === UNREADABLE) return true;
  if (!('org_id' in parsed)) return false;

  const value = parsed.org_id;
  if (value === undefined) return false;
  if (typeof value !== 'string') return true;

  const target = value.trim().toLowerCase();
  if (target.length === 0) return false;

  const own = typeof ownOrgId === 'string' ? ownOrgId.trim().toLowerCase() : '';
  if (own.length === 0) return true;

  return target !== own;
}

/**
 * The one table. Answers, per (tool, args):
 *   'deny'     — not callable by the operator at all.
 *   'approval' — callable, but the turn must pause for a human.
 *   'allow'    — callable freely.
 *
 * Gating comes from substrate's own policy engine and nothing else: a
 * `manage_substrate` propose of an approval_required capability. Every other
 * allowlisted tool is 'allow' by decision, including manage_integrations
 * (see the allowlist comment).
 *
 * PRECEDENCE, in this order and no other:
 *
 *   deny  >  approval  >  allow
 *
 *   1. deny, per TOOL     — not on OPERATOR_TOOL_ALLOWLIST.
 *   2. deny, per ACTION   — OPERATOR_DENIED_SUBSTRATE_ACTIONS. A denied action
 *                           can never be downgraded to approval or allow by
 *                           anything else in the args.
 *   3. approval, per ACTION     — OPERATOR_APPROVAL_SUBSTRATE_ACTIONS.
 *   4. approval, per CAPABILITY — propose of a SUBSTRATE_APPROVAL_REQUIRED one.
 *   5. allow              — the floor.
 *
 * The two approval rules (3 and 4) are independent gating sources and are meant
 * to be: rule/outbox mutations are not capability proposals, so no single
 * source could cover both. They are both here, in one table, by design.
 */
export function operatorPolicyFor(name: string, args: unknown): OperatorPolicy {
  // 1. Tool-level deny.
  if (!OPERATOR_TOOL_ALLOWLIST.has(name)) return 'deny';

  if (name === 'manage_substrate') {
    // The action rules below are the whole substrate guardrail, so anything we
    // cannot read confidently is denied rather than waved through.
    const parsed = coerceArgs(args);
    if (parsed === UNREADABLE) return 'deny';

    const action = readAction(parsed);
    if (action === UNREADABLE) return 'deny';

    if (action) {
      // 2. Controls the operator must not be able to weaken. Checked ahead of
      // every approval path, so a denial is never downgraded.
      if (OPERATOR_DENIED_SUBSTRATE_ACTIONS.has(action)) return 'deny';

      // 3. Oversight-weakening actions that a human may still authorise.
      if (OPERATOR_APPROVAL_SUBSTRATE_ACTIONS.has(action)) return 'approval';

      // 4. Substrate's own policy engine: a propose of an approval_required
      // capability.
      if (action === 'propose') {
        const capability = readStringField(parsed, 'capability');
        if (capability && SUBSTRATE_APPROVAL_REQUIRED_CAPABILITIES.has(capability)) return 'approval';
      }
    }
  }

  // 5. Floor.
  return 'allow';
}

/**
 * The table, plus the cross-org guard, for a caller whose own organization is
 * known.
 *
 * Kept as a WRAPPER rather than a third parameter on `operatorPolicyFor`
 * because the org id is not a property of the policy tables — the tables say
 * what the operator may do, this says where it may do it — and because the
 * dangerous principal never reaches `operatorPolicyFor` at all:
 * `principalMayExecute('human', …)` short-circuits to the tool-level
 * allowlist, so widening `operatorPolicyFor`'s signature alone would have left
 * the approval replay — the one reachable path — unguarded. The guard is
 * therefore ALSO applied directly in `executeOnce` (tool-bridge.ts).
 *
 * Precedence: a foreign `org_id` is 'deny' ahead of everything, including the
 * tool allowlist. There is no tool for which targeting another org is
 * legitimate, so nothing below it needs to be consulted.
 */
export function operatorPolicyForOrg(
  name: string,
  args: unknown,
  operatorOrgId: string | null | undefined,
): OperatorPolicy {
  if (orgIdArgIsForeign(args, operatorOrgId)) return 'deny';
  return operatorPolicyFor(name, args);
}

/** Thin wrapper over the table: may the operator call this tool at all? */
export function isOperatorToolAllowed(name: string): boolean {
  return operatorPolicyFor(name, undefined) !== 'deny';
}

/** Thin wrapper over the table: must this call pause for a human? */
export function operatorRequiresApproval(name: string, args: unknown): boolean {
  return operatorPolicyFor(name, args) === 'approval';
}

/**
 * Who is making this call? The two are NOT interchangeable and the difference
 * is load-bearing, which is why `executeOnce` takes it as a required argument
 * rather than defaulting.
 *
 *  - 'operator' — the unattended agent, holding an org service key, nobody
 *    watching. Gets the full table above, including the action denials whose
 *    whole point is that an agent must not weaken the controls that govern it.
 *
 *  - 'human'  — a person clicked approve in the operator approvals feed, and
 *    the server is now acting on their behalf. The action denials do not
 *    apply: they say "the AGENT must not approve its own proposal", not "this
 *    endpoint is off limits". Without this distinction the approval bridge
 *    could not call substrate's native approve(action_id) at all, because
 *    `approve` is denied to the operator.
 */
export type OperatorPrincipal = 'operator' | 'human';

/**
 * May `principal` execute (tool, args) through the approval bridge?
 *
 * A 'human' principal is still confined to the operator's TOOL surface. This
 * path only ever executes tool calls the operator itself proposed, so nothing
 * legitimate can name a tool outside the allowlist; keeping the tool-level
 * check means a corrupted or hand-inserted approval row cannot turn the
 * approve button into arbitrary tool execution. Only the substrate ACTION
 * denials — the agent-specific ones — are lifted.
 */
export function principalMayExecute(
  principal: OperatorPrincipal,
  name: string,
  args: unknown,
): boolean {
  // Loop-internal tools are not reachable through this path for EITHER
  // principal. `executeOnce` ends in `callMcpTool`, and no MCP tool answers to
  // these names, so the only way one could arrive here is a corrupted or
  // hand-inserted approval row (they never gate, so no legitimate approval can
  // name one). Refusing by name is clearer than letting it fail at the MCP
  // server, and keeps the allowlist from implying an execution route it does
  // not have.
  if (OPERATOR_LOCAL_TOOLS.has(name)) return false;
  if (principal === 'operator') return operatorPolicyFor(name, args) !== 'deny';
  if (principal === 'human') return OPERATOR_TOOL_ALLOWLIST.has(name);
  // Unknown principal — including `undefined` from a JavaScript caller or a
  // test that predates the argument. Fail closed rather than inheriting
  // whichever branch happens to be listed last.
  return false;
}
