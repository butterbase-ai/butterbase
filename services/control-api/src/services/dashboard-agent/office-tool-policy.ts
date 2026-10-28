/**
 * Office tool policy — the CONSEQUENTIAL floor for a customer Office.
 *
 * `operator-policy.ts` answers "what may the unattended operator do, and what
 * must pause for its owner?" for every deployment of Butterbase, including
 * self-hosted. Its `approval` tier is deliberately yolo-liftable: a self-hosted
 * org that sets `yolo_mode` is pre-authorising that tier for itself.
 *
 * A customer Office is a different product surface. The spec is explicit:
 * Office "must obtain approval before deploying, changing live app
 * data/schema/configuration, deleting or merging records, or contacting a
 * customer", and "Customer Office does not inherit the substrate `yolo_mode`
 * shortcut for consequential actions". This module is that narrower answer.
 * The loop combines it with `operatorPolicyFor` through
 * `resolveOfficeVerdict`, and never lets yolo promote an Office 'approval'.
 * How the two verdicts combine — including why Office 'allow' is authoritative
 * over the operator table's yolo-liftable 'approval' tier — is documented on
 * `resolveOfficeVerdict` in operator-policy.ts.
 *
 * DESIGN SHAPE, and why it is two tables rather than one:
 *
 *  - `OPERATOR_ALLOWED_TOOLS` is a POSITIVE list of reads, preparation and
 *    builds. Everything else is 'approval' — so a tool added to the catalog
 *    tomorrow is gated for Office by default, exactly like the operator table's
 *    deny-by-default floor. Do not invert this into a deny-list.
 *  - A few tools are action-dispatched, and their read actions are safe while
 *    their writes are not (`manage_schema get` vs `apply`). Those get an
 *    explicit action rule. An unknown action on one of them is 'approval', not
 *    'allow' — see `manage_integrations`, whose execute path is the real
 *    outbound-mail route.
 *  - `manage_substrate` is the one tool with a 'deny' answer, and it mirrors
 *    `OPERATOR_DENIED_SUBSTRATE_ACTIONS`: an agent must never be able to
 *    approve its own proposal, switch yolo on for itself, or close its own
 *    policy conflicts. Those are not gateable-with-approval — a gate the agent
 *    can propose its way through is not a control.
 *
 * WHAT THIS MODULE IS NOT: it does not own the cross-org guard or the agent's
 * self-approval denials — the operator table does, and those survive Office
 * mode untouched (see `resolveOfficeVerdict`). What the Office verdict DOES
 * replace is the operator table's `approval` tier, because that tier is a
 * general unattended-agent safety affordance (a self-hosted org can lift it
 * with `yolo_mode`), not the customer Office contract. Office preparation —
 * writing the working tree, reading files, building in a sandbox — is
 * explicitly autonomous in the spec, so leaving `write_file` gated because the
 * operator table gates it would contradict the product. The direction of
 * travel is therefore:
 *
 *   - Office 'approval' is binding and yolo may not lift it.
 *   - Office 'allow' is authoritative over an operator 'approval' (this is
 *     how preparation stays autonomous without requiring yolo).
 *   - An operator 'deny' is ALWAYS preserved — cross-org targeting and the
 *     self-approval/control-weakening denials are not product trade-offs.
 */
import {
  OPERATOR_ALLOWED_SUBSTRATE_ACTIONS,
  OPERATOR_APPROVAL_SUBSTRATE_ACTIONS,
  OPERATOR_DENIED_SUBSTRATE_ACTIONS,
  SUBSTRATE_APPROVAL_REQUIRED_CAPABILITIES,
} from './operator-policy.js';

export type OfficeToolVerdict = 'allow' | 'approval' | 'deny';

/**
 * Tools that are ALWAYS reads, preparation or builds.
 *
 * Deliberately explicit rather than derived from the operator table: the
 * operator table is the general contract and may allow things a customer
 * Office must not do autonomously (that is the entire reason this module
 * exists). Adding a tool here is a deliberate statement that it reaches no
 * live tenant state.
 *
 * `write_file` / `delete_file` are here because they write the turn's
 * IN-MEMORY working tree — preparation. Nothing reaches a user until
 * `deploy_frontend`, which is not here.
 */
const OPERATOR_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  // Documentation and platform reads
  'butterbase_docs',
  'list_regions',
  'query_audit_logs',
  'list_partner_apis',
  'submit_suggestion',
  // Data reads
  'select_rows',
  'rag_query',
  'manage_people',
  // Workspace preparation
  'write_file',
  'read_file',
  'list_files',
  'delete_file',
  // Build and sandbox
  'run_sandbox_code',
  'build_app',
  // Operator working state
  'update_operator_scratchpad',
  'list_pending_decisions',
  // Office skills: the creator drafts and enqueues a read-only test; it cannot
  // run, approve, deploy or send. The script executor is scoped to the pinned
  // package and its sandbox is network-denied.
  'skill_creator',
  'run_skill_script',
]);

/**
 * Per-action rules for tools that mix reads with live writes.
 *
 * `defaultAllow` says what an action NOT listed in `allow`/`approval` gets.
 * Only tools whose action surface is open-ended (a tool whose future actions
 * are almost certainly more reads) should set it true. Everything else leaves
 * it false, so an unknown action is gated — which is the safe direction for
 * `manage_integrations`, the real outbound path.
 */
type ActionRule = {
  allow: ReadonlySet<string>;
  approval: ReadonlySet<string>;
  defaultAllow: boolean;
};

const set = (values: string[]): ReadonlySet<string> => new Set(values);

const ACTION_RULES: Readonly<Record<string, ActionRule>> = {
  manage_app: {
    allow: set(['list', 'get_config', 'get_clone_job', 'find_templates', 'move_status', 'get_env', 'list_template_releases', 'get_template_release', 'check_template_updates']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_schema: {
    allow: set(['get', 'dry_run', 'list_migrations']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_rls: {
    allow: set(['list']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_migrations: {
    allow: set(['get', 'dry_run', 'list_migrations']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_function: {
    allow: set(['list', 'get', 'get_logs']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_auth_users: {
    allow: set(['list']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_oauth: {
    allow: set(['get']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_api_keys: {
    allow: set(['list']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_storage: {
    allow: set(['list', 'download_url']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_kv: {
    allow: set(['get', 'list_rules', 'stats', 'scan', 'exists', 'ttl', 'mget']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_realtime: {
    allow: set(['get']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_durable_objects: {
    allow: set(['list', 'get', 'usage', 'list_env']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_edge_ssr: {
    allow: set(['list']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_rag_content: {
    allow: set(['list_collections', 'get_collection', 'list_documents', 'get_document_status']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_agents: {
    allow: set(['list', 'get', 'validate']),
    approval: set([]),
    defaultAllow: false,
  },
  manage_billing: {
    allow: set(['status', 'cap_get', 'plans', 'usage']),
    approval: set(['portal', 'topup', 'cap_raise']),
    defaultAllow: false,
  },
  /**
   * The outbound path. Reads are reads; every other action — including one
   * this table has never heard of — is an execution and needs a human. The
   * operator table deliberately leaves `manage_integrations` fully un-gated
   * (accepted risk 2026-08-05/06); a customer Office does not inherit that
   * decision.
   */
  manage_integrations: {
    allow: set(['list_available', 'list_connected', 'list_tools', 'execute_read']),
    approval: set([]),
    defaultAllow: false,
  },
  /**
   * Repo preparation is safe: `push` writes an immutable snapshot and no
   * reader of the app sees it. `wipe` deletes every snapshot — the one
   * destructive action, and the only one named here.
   */
  manage_repo: {
    allow: set([]),
    approval: set(['wipe']),
    defaultAllow: true,
  },
  /**
   * App-facing AI gateway calls spend the org's credits and produce assets,
   * which is Office's ordinary work. Changing the gateway config, joining or
   * leaving a live meeting, or changing the meetings webhook reaches a person
   * or the money path and needs a human.
   */
  manage_ai: {
    allow: set([]),
    approval: set(['update_config', 'configure_meetings_webhook', 'start_meeting', 'stop_meeting']),
    defaultAllow: true,
  },
};

/** Sentinel: args were supplied but could not be understood. Fails closed. */
const UNREADABLE = Symbol('unreadable-args');

/**
 * Normalise args the same way operator-policy.ts does. Duplicated rather than
 * imported because that helper is private to the policy module and this one
 * has a different failure answer (`approval` for ordinary tools, `deny` for
 * `manage_substrate`). Both fail closed; neither trusts a caller to have
 * parsed first.
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

function readAction(args: Record<string, unknown>): string | null | typeof UNREADABLE {
  if (!('action' in args)) return null;
  const value = args.action;
  if (value === undefined) return null;
  if (typeof value !== 'string') return UNREADABLE;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function readCapability(args: Record<string, unknown>): string | null | typeof UNREADABLE {
  if (!('capability' in args)) return null;
  const value = args.capability;
  if (value === undefined) return null;
  if (typeof value !== 'string') return UNREADABLE;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * `manage_substrate`, action by action. The precedence mirrors
 * operator-policy.ts exactly: deny > approval > allow, and the deny set is
 * checked first so no approval path can downgrade it.
 */
function classifySubstrate(args: unknown): OfficeToolVerdict {
  const parsed = coerceArgs(args);
  if (parsed === UNREADABLE) return 'deny';

  const action = readAction(parsed);
  if (action === UNREADABLE) return 'deny';
  if (!action) return 'allow';

  // 1. Controls the agent must not be able to weaken.
  if (OPERATOR_DENIED_SUBSTRATE_ACTIONS.has(action)) return 'deny';

  // 2. Oversight-weakening automation a human may still authorise.
  if (OPERATOR_APPROVAL_SUBSTRATE_ACTIONS.has(action)) return 'approval';

  // 3. Substrate's own approval-required capabilities.
  if (action === 'propose') {
    const capability = readCapability(parsed);
    if (capability === UNREADABLE) return 'approval';
    if (capability && SUBSTRATE_APPROVAL_REQUIRED_CAPABILITIES.has(capability)) return 'approval';
  }

  // Reads, memory writes, and every other substrate action the operator table
  // already classifies as allow. `propose` of a capability that is NOT on the
  // approval-required list is an ordinary memory write; the eight that are
  // were handled above.
  if (action === 'propose') return 'allow';
  if (OPERATOR_ALLOWED_SUBSTRATE_ACTIONS.has(action)) return 'allow';

  // An action nobody classified is not a read.
  return 'approval';
}

/**
 * The one answer. 'allow' may still be gated by the operator table; 'approval'
 * may never be lifted by yolo; 'deny' is absolute.
 */
export function classifyOfficeTool(name: string, args: unknown): OfficeToolVerdict {
  if (name === 'manage_substrate') return classifySubstrate(args);

  if (OPERATOR_ALLOWED_TOOLS.has(name)) return 'allow';

  const rule = ACTION_RULES[name];
  if (rule) {
    const parsed = coerceArgs(args);
    if (parsed === UNREADABLE) return 'approval';
    const action = readAction(parsed);
    if (action === UNREADABLE) return 'approval';
    if (action === null) return rule.defaultAllow ? 'allow' : 'approval';
    if (rule.approval.has(action)) return 'approval';
    if (rule.allow.has(action)) return 'allow';
    return rule.defaultAllow ? 'allow' : 'approval';
  }

  // Everything else — deploys, live writes, and any tool nobody has classified
  // yet — needs a human.
  return 'approval';
}
