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

export type OperatorPolicy = 'allow' | 'approval' | 'deny';

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
 */
export const OPERATOR_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'manage_substrate',
  'manage_integrations',
  'manage_people',
  'query_audit_logs',
  'select_rows',
  'butterbase_docs',
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
 * This is an OPERATOR-ONLY restriction. The human assistant keeps full access
 * to both actions, and both stay documented in the shared tool catalog.
 */
export const OPERATOR_DENIED_SUBSTRATE_ACTIONS: ReadonlySet<string> = new Set([
  'set_yolo',
  'resolve_policy_conflict',
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

function readStringField(args: unknown, key: string): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
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
    const action = readStringField(args, 'action');

    if (action) {
      // 2. Controls the operator must not be able to weaken. Checked ahead of
      // every approval path, so a denial is never downgraded.
      if (OPERATOR_DENIED_SUBSTRATE_ACTIONS.has(action)) return 'deny';

      // 3. Oversight-weakening actions that a human may still authorise.
      if (OPERATOR_APPROVAL_SUBSTRATE_ACTIONS.has(action)) return 'approval';

      // 4. Substrate's own policy engine: a propose of an approval_required
      // capability.
      if (action === 'propose') {
        const capability = readStringField(args, 'capability');
        if (capability && SUBSTRATE_APPROVAL_REQUIRED_CAPABILITIES.has(capability)) return 'approval';
      }
    }
  }

  // 5. Floor.
  return 'allow';
}

/** Thin wrapper over the table: may the operator call this tool at all? */
export function isOperatorToolAllowed(name: string): boolean {
  return operatorPolicyFor(name, undefined) !== 'deny';
}

/** Thin wrapper over the table: must this call pause for a human? */
export function operatorRequiresApproval(name: string, args: unknown): boolean {
  return operatorPolicyFor(name, args) === 'approval';
}
