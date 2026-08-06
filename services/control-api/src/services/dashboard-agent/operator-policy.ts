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
 */
export function operatorPolicyFor(name: string, args: unknown): OperatorPolicy {
  if (!OPERATOR_TOOL_ALLOWLIST.has(name)) return 'deny';

  if (name === 'manage_substrate' && readStringField(args, 'action') === 'propose') {
    const capability = readStringField(args, 'capability');
    if (capability && SUBSTRATE_APPROVAL_REQUIRED_CAPABILITIES.has(capability)) return 'approval';
  }

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
