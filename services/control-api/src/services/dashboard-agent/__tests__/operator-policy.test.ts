import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  operatorPolicyFor,
  isOperatorToolAllowed,
  operatorRequiresApproval,
  OPERATOR_TOOL_ALLOWLIST,
  OPERATOR_DENIED_SUBSTRATE_ACTIONS,
  OPERATOR_APPROVAL_SUBSTRATE_ACTIONS,
  OPERATOR_ALLOWED_SUBSTRATE_ACTIONS,
  SUBSTRATE_APPROVAL_REQUIRED_CAPABILITIES,
  principalMayExecute,
} from '../operator-policy.js';
import { getToolCatalog, sensitivityFor } from '../tool-catalog.js';

const APPROVAL_REQUIRED = [
  'send_email_draft',
  'delete_entity',
  'merge_entities',
  'record_principle',
  'amend_principle',
  'retire_principle',
  'supersede_decision',
  'bulk_revert_actions',
];

const AUTO = [
  'upsert_entity',
  'update_entity',
  'patch_entity',
  'record_decision',
  'record_commitment',
  'record_learning',
  'revert_action',
  'upsert_source_artifact',
];

describe('operatorPolicyFor — deny', () => {
  it('denies anything not on the allowlist', () => {
    for (const name of ['manage_app', 'manage_billing', 'manage_api_keys', 'seed_database', 'write_file', 'not_a_real_tool']) {
      expect(operatorPolicyFor(name, {})).toBe('deny');
      expect(isOperatorToolAllowed(name)).toBe(false);
    }
  });

  it('denies the empty / malformed tool name', () => {
    expect(operatorPolicyFor('', {})).toBe('deny');
  });
});

describe('operatorPolicyFor — allow', () => {
  it('allows the read-only allowlisted tools without approval', () => {
    for (const name of ['query_audit_logs', 'select_rows', 'butterbase_docs', 'manage_people']) {
      expect(operatorPolicyFor(name, {})).toBe('allow');
      expect(isOperatorToolAllowed(name)).toBe(true);
      expect(operatorRequiresApproval(name, {})).toBe(false);
    }
  });

  it('manage_integrations is allowed and deliberately NOT gated (accepted risk, 2026-08-05/06)', () => {
    expect(operatorPolicyFor('manage_integrations', { action: 'send_email' })).toBe('allow');
    expect(operatorPolicyFor('manage_integrations', {})).toBe('allow');
    expect(operatorRequiresApproval('manage_integrations', { action: 'execute' })).toBe(false);
  });
});

describe('operatorPolicyFor — manage_substrate gating comes from substrate policy only', () => {
  it('allows substrate reads', () => {
    for (const action of ['list_actions', 'find_entities', 'search_memory', 'list_capabilities', 'get_entity']) {
      expect(operatorPolicyFor('manage_substrate', { action })).toBe('allow');
    }
  });

  it.each(APPROVAL_REQUIRED)('propose %s requires approval', (capability) => {
    expect(operatorPolicyFor('manage_substrate', { action: 'propose', capability })).toBe('approval');
    expect(operatorRequiresApproval('manage_substrate', { action: 'propose', capability })).toBe(true);
  });

  it.each(AUTO)('propose %s does not require approval', (capability) => {
    expect(operatorPolicyFor('manage_substrate', { action: 'propose', capability })).toBe('allow');
  });

  it('an approval_required capability name outside a propose does not gate', () => {
    // e.g. list_actions filtered by capability — a read, not a write.
    expect(operatorPolicyFor('manage_substrate', { action: 'list_actions', capability: 'delete_entity' })).toBe('allow');
  });

  it('an unknown capability on propose does not gate (substrate itself rejects it)', () => {
    expect(operatorPolicyFor('manage_substrate', { action: 'propose', capability: 'not_a_capability' })).toBe('allow');
  });

  it('tolerates missing args (no action named — nothing to deny)', () => {
    expect(operatorPolicyFor('manage_substrate', undefined)).toBe('allow');
    expect(operatorPolicyFor('manage_substrate', null)).toBe('allow');
    expect(operatorPolicyFor('manage_substrate', { action: 'propose', capability: 42 })).toBe('allow');
  });
});

describe('operatorPolicyFor — control-weakening substrate actions are denied outright', () => {
  it('denies set_yolo (would switch off substrate\'s own gate, org-wide)', () => {
    expect(operatorPolicyFor('manage_substrate', { action: 'set_yolo', yolo_mode: true })).toBe('deny');
    expect(operatorPolicyFor('manage_substrate', { action: 'set_yolo', yolo_mode: false })).toBe('deny');
    expect(operatorPolicyFor('manage_substrate', { action: 'set_yolo' })).toBe('deny');
  });

  it('denies resolve_policy_conflict (the record says a HUMAN disposed of it)', () => {
    expect(
      operatorPolicyFor('manage_substrate', { action: 'resolve_policy_conflict', conflict_id: 'pcf_1', resolution: 'overridden' }),
    ).toBe('deny');
    expect(operatorPolicyFor('manage_substrate', { action: 'resolve_policy_conflict' })).toBe('deny');
  });

  it('denial is not gateable — it can never be reached via propose', () => {
    for (const action of ['set_yolo', 'resolve_policy_conflict']) {
      expect(operatorRequiresApproval('manage_substrate', { action })).toBe(false);
      expect(operatorPolicyFor('manage_substrate', { action, capability: 'delete_entity' })).toBe('deny');
    }
  });

  it('the denial is per-action: reads, settings reads and propose are unaffected', () => {
    expect(operatorPolicyFor('manage_substrate', { action: 'get_settings' })).toBe('allow');
    expect(operatorPolicyFor('manage_substrate', { action: 'list_policy_conflicts' })).toBe('allow');
    expect(operatorPolicyFor('manage_substrate', { action: 'get_policy_conflict', conflict_id: 'pcf_1' })).toBe('allow');
    expect(operatorPolicyFor('manage_substrate', { action: 'list_capabilities' })).toBe('allow');
    expect(operatorPolicyFor('manage_substrate', { action: 'propose', capability: 'record_decision' })).toBe('allow');
    expect(operatorPolicyFor('manage_substrate', { action: 'propose', capability: 'delete_entity' })).toBe('approval');
  });

  it('the operator surface never contains a control-weakening action', () => {
    for (const action of OPERATOR_DENIED_SUBSTRATE_ACTIONS) {
      expect(operatorPolicyFor('manage_substrate', { action })).toBe('deny');
    }
    expect(OPERATOR_DENIED_SUBSTRATE_ACTIONS.has('set_yolo')).toBe(true);
    expect(OPERATOR_DENIED_SUBSTRATE_ACTIONS.has('resolve_policy_conflict')).toBe(true);
  });

  it('is an operator-only restriction — the human assistant is untouched', () => {
    // sensitivityFor governs the human-attended assistant and must not change.
    expect(sensitivityFor('manage_substrate', { action: 'set_yolo', yolo_mode: true })).toBe('safe');
    expect(sensitivityFor('manage_substrate', { action: 'resolve_policy_conflict' })).toBe('safe');
    // and the tool is still fully described in the shared catalog
    const spec = getToolCatalog().find((t) => t.name === 'manage_substrate')!;
    expect(spec.description).toContain('set_yolo');
    expect(spec.description).toContain('resolve_policy_conflict');
  });
});

describe('operatorPolicyFor — oversight-weakening substrate actions require approval', () => {
  const RULE_ACTIONS = ['create_rule', 'delete_rule', 'disable_rule', 'enable_rule', 'cancel_outbox'];

  it.each(RULE_ACTIONS)('%s requires approval', (action) => {
    expect(operatorPolicyFor('manage_substrate', { action })).toBe('approval');
    expect(operatorRequiresApproval('manage_substrate', { action })).toBe(true);
  });

  it('the exported set is exactly those five actions and every member gates', () => {
    expect([...OPERATOR_APPROVAL_SUBSTRATE_ACTIONS].sort()).toEqual([...RULE_ACTIONS].sort());
    for (const action of OPERATOR_APPROVAL_SUBSTRATE_ACTIONS) {
      expect(operatorPolicyFor('manage_substrate', { action })).toBe('approval');
    }
  });

  it('gates with realistic args, not just a bare action', () => {
    expect(operatorPolicyFor('manage_substrate', { action: 'create_rule', rule: { name: 'nightly' } })).toBe('approval');
    expect(operatorPolicyFor('manage_substrate', { action: 'delete_rule', rule_id: 'rule_1' })).toBe('approval');
    expect(operatorPolicyFor('manage_substrate', { action: 'cancel_outbox', outbox_id: 'obx_1' })).toBe('approval');
  });

  it('rule READS are unaffected — only mutations gate', () => {
    for (const action of ['list_rules', 'get_rule', 'list_rule_firings', 'list_outbox']) {
      expect(operatorPolicyFor('manage_substrate', { action })).toBe('allow');
    }
  });

  it('update_rule and retry_outbox are deliberately NOT in this set (plan author named five)', () => {
    expect(OPERATOR_APPROVAL_SUBSTRATE_ACTIONS.has('update_rule')).toBe(false);
    expect(OPERATOR_APPROVAL_SUBSTRATE_ACTIONS.has('retry_outbox')).toBe(false);
  });
});

describe('operatorPolicyFor — precedence: deny > approval > allow', () => {
  it('the two gating sources are disjoint', () => {
    for (const action of OPERATOR_DENIED_SUBSTRATE_ACTIONS) {
      expect(OPERATOR_APPROVAL_SUBSTRATE_ACTIONS.has(action)).toBe(false);
    }
  });

  it('a denied action stays deny and cannot be downgraded to approval or allow', () => {
    for (const action of OPERATOR_DENIED_SUBSTRATE_ACTIONS) {
      expect(operatorPolicyFor('manage_substrate', { action })).toBe('deny');
      // even paired with anything that would otherwise gate or allow
      expect(operatorPolicyFor('manage_substrate', { action, capability: 'delete_entity' })).toBe('deny');
      expect(operatorPolicyFor('manage_substrate', { action, capability: 'record_decision' })).toBe('deny');
      expect(operatorRequiresApproval('manage_substrate', { action })).toBe(false);
    }
  });

  it('deny at the TOOL level beats every action rule', () => {
    // manage_app is not allowlisted; no action can rescue it.
    for (const action of ['create_rule', 'set_yolo', 'propose', 'list_rules']) {
      expect(operatorPolicyFor('manage_app', { action })).toBe('deny');
    }
  });

  it('approval beats allow, and allow remains the floor', () => {
    expect(operatorPolicyFor('manage_substrate', { action: 'create_rule' })).toBe('approval');
    expect(operatorPolicyFor('manage_substrate', { action: 'list_rules' })).toBe('allow');
  });

  it('the propose rule is unaffected by the new action rule', () => {
    expect(operatorPolicyFor('manage_substrate', { action: 'propose', capability: 'delete_entity' })).toBe('approval');
    expect(operatorPolicyFor('manage_substrate', { action: 'propose', capability: 'send_email_draft' })).toBe('approval');
    expect(operatorPolicyFor('manage_substrate', { action: 'propose', capability: 'record_decision' })).toBe('allow');
    expect(operatorPolicyFor('manage_substrate', { action: 'propose', capability: 'upsert_entity' })).toBe('allow');
  });

  it('other allowlisted tools are untouched by substrate action rules', () => {
    expect(operatorPolicyFor('manage_integrations', { action: 'create_rule' })).toBe('allow');
    expect(operatorPolicyFor('select_rows', { action: 'set_yolo' })).toBe('allow');
  });
});

describe('operatorPolicyFor — the operator cannot approve or reject its own proposals', () => {
  it('denies approve (would execute the capability and stamp approved_by_kind=human)', () => {
    expect(operatorPolicyFor('manage_substrate', { action: 'approve', action_id: 'act_1' })).toBe('deny');
    expect(operatorPolicyFor('manage_substrate', { action: 'approve' })).toBe('deny');
  });

  it('denies reject (no execution, but forges the same human-decision fields)', () => {
    expect(operatorPolicyFor('manage_substrate', { action: 'reject', action_id: 'act_1', reason: 'no' })).toBe('deny');
    expect(operatorPolicyFor('manage_substrate', { action: 'reject' })).toBe('deny');
  });

  it('closes the propose-then-self-approve loop end to end', () => {
    // The gated proposal is correctly held...
    expect(operatorPolicyFor('manage_substrate', { action: 'propose', capability: 'send_email_draft' })).toBe('approval');
    // ...and the operator cannot then satisfy that gate itself.
    expect(operatorPolicyFor('manage_substrate', { action: 'approve', action_id: 'act_1' })).toBe('deny');
  });

  it('the denial is not reachable through propose or any crafted arg shape', () => {
    for (const action of ['approve', 'reject']) {
      expect(operatorPolicyFor('manage_substrate', { action, capability: 'record_decision' })).toBe('deny');
      expect(operatorPolicyFor('manage_substrate', { action, capability: 'delete_entity' })).toBe('deny');
      expect(operatorPolicyFor('manage_substrate', { capability: 'send_email_draft', action })).toBe('deny');
      expect(operatorRequiresApproval('manage_substrate', { action })).toBe(false);
    }
    // an inner `propose` cannot smuggle an approve past the check
    expect(operatorPolicyFor('manage_substrate', { action: 'approve', payload: { action: 'propose' } })).toBe('deny');
  });

  it('ledger READS are unaffected', () => {
    for (const action of ['get_action', 'list_actions']) {
      expect(operatorPolicyFor('manage_substrate', { action })).toBe('allow');
    }
  });

  it('both are in the denied set alongside the round-1 pair', () => {
    for (const action of ['approve', 'reject', 'set_yolo', 'resolve_policy_conflict']) {
      expect(OPERATOR_DENIED_SUBSTRATE_ACTIONS.has(action)).toBe(true);
    }
  });
});

describe('operatorPolicyFor — the deny table normalises its own input (does not rely on downstream zod)', () => {
  const DENIED = ['set_yolo', 'resolve_policy_conflict', 'approve', 'reject'];

  it.each(DENIED)('denies %s regardless of case', (action) => {
    expect(operatorPolicyFor('manage_substrate', { action: action.toUpperCase() })).toBe('deny');
    expect(operatorPolicyFor('manage_substrate', { action: action[0].toUpperCase() + action.slice(1) })).toBe('deny');
  });

  it.each(DENIED)('denies %s regardless of surrounding whitespace', (action) => {
    expect(operatorPolicyFor('manage_substrate', { action: ` ${action}` })).toBe('deny');
    expect(operatorPolicyFor('manage_substrate', { action: `${action}  ` })).toBe('deny');
    expect(operatorPolicyFor('manage_substrate', { action: `\t ${action} \n` })).toBe('deny');
    expect(operatorPolicyFor('manage_substrate', { action: `  ${action.toUpperCase()}  ` })).toBe('deny');
  });

  it('normalises the approval set and the propose rule too', () => {
    expect(operatorPolicyFor('manage_substrate', { action: ' CREATE_RULE ' })).toBe('approval');
    expect(operatorPolicyFor('manage_substrate', { action: ' PROPOSE ', capability: 'delete_entity' })).toBe('approval');
  });

  it('args arriving as a JSON string are parsed, not waved through', () => {
    expect(operatorPolicyFor('manage_substrate', JSON.stringify({ action: 'set_yolo', yolo_mode: true }))).toBe('deny');
    expect(operatorPolicyFor('manage_substrate', JSON.stringify({ action: 'approve', action_id: 'act_1' }))).toBe('deny');
    expect(operatorPolicyFor('manage_substrate', JSON.stringify({ action: 'create_rule' }))).toBe('approval');
    expect(operatorPolicyFor('manage_substrate', JSON.stringify({ action: 'list_rules' }))).toBe('allow');
  });

  it('unparseable or non-object string args FAIL CLOSED for manage_substrate', () => {
    for (const bad of ['nonsense', '{"action":', '[]', '"set_yolo"', '42', 'null', '']) {
      expect(operatorPolicyFor('manage_substrate', bad)).toBe('deny');
    }
  });

  it('a non-string action fails closed rather than falling through to allow', () => {
    for (const bad of [{ action: 42 }, { action: null }, { action: ['set_yolo'] }, { action: { toString: () => 'set_yolo' } }]) {
      expect(operatorPolicyFor('manage_substrate', bad)).toBe('deny');
    }
  });

  it('normalisation does not widen the net to unrelated actions', () => {
    expect(operatorPolicyFor('manage_substrate', { action: 'set_yolo_mode' })).toBe('allow');
    expect(operatorPolicyFor('manage_substrate', { action: 'approve_all' })).toBe('allow');
    expect(operatorPolicyFor('manage_substrate', { action: 'list_actions' })).toBe('allow');
  });

  it('other allowlisted tools keep tolerating loose args (this is a substrate-surface rule)', () => {
    expect(operatorPolicyFor('select_rows', 'anything')).toBe('allow');
    expect(operatorPolicyFor('manage_integrations', { action: 'APPROVE' })).toBe('allow');
  });
});

describe('C1 regression — allowlist ∩ gateable is no longer empty', () => {
  it('at least one allowlisted tool can actually produce an approval', () => {
    const gateable = [...OPERATOR_TOOL_ALLOWLIST].filter((name) =>
      // every approval_required capability, tried against every allowlisted tool
      APPROVAL_REQUIRED.some((capability) => operatorPolicyFor(name, { action: 'propose', capability }) === 'approval'),
    );
    expect(gateable.length).toBeGreaterThan(0);
    expect(gateable).toContain('manage_substrate');
  });

  it('every gateable call is also callable by the operator (no approval for a denied tool)', () => {
    for (const name of [...OPERATOR_TOOL_ALLOWLIST, 'manage_billing', 'manage_app']) {
      const verdict = operatorPolicyFor(name, { action: 'propose', capability: 'delete_entity' });
      if (verdict === 'approval') expect(OPERATOR_TOOL_ALLOWLIST.has(name)).toBe(true);
    }
  });

  it('operator gating is independent of sensitivityFor (the human assistant\'s tier)', () => {
    // sensitivityFor governs the human-attended assistant and must stay 'safe' here.
    expect(sensitivityFor('manage_substrate', { action: 'propose', capability: 'delete_entity' })).toBe('safe');
    expect(operatorPolicyFor('manage_substrate', { action: 'propose', capability: 'delete_entity' })).toBe('approval');
  });
});

describe('I1 regression — manage_substrate is in the tool catalog', () => {
  const catalog = getToolCatalog();

  it('is present exactly once', () => {
    expect(catalog.filter((t) => t.name === 'manage_substrate')).toHaveLength(1);
  });

  it('documents propose and the approval-gated capabilities', () => {
    const spec = catalog.find((t) => t.name === 'manage_substrate')!;
    expect(spec.description).toContain('propose');
    for (const capability of APPROVAL_REQUIRED) expect(spec.description).toContain(capability);
    expect(spec.parameters).toBeTypeOf('object');
  });

  it('every allowlisted tool exists in the catalog', () => {
    const names = new Set(catalog.map((t) => t.name));
    for (const name of OPERATOR_TOOL_ALLOWLIST) expect(names).toContain(name);
  });
});

/**
 * Drift guard. substrate-core lives in the internal monorepo (cloud/packages/
 * substrate-core) and is NOT reachable from this OSS package, so the eight
 * approval_required capability names are mirrored locally. This test reads the
 * real capability sources when the internal checkout is present and fails if
 * the two ever disagree. In a standalone OSS checkout the directory does not
 * exist and the test skips.
 */
function findSubstrateCapabilitiesDir(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'cloud', 'packages', 'substrate-core', 'src', 'capabilities');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

describe('drift guard vs substrate-core capability registry', () => {
  const dir = findSubstrateCapabilitiesDir();

  it.skipIf(dir === null)('local approval_required list matches substrate-core default_policy', () => {
    const found = new Set<string>();
    let seen = 0;
    for (const file of fs.readdirSync(dir!)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'index.ts') continue;
      const src = fs.readFileSync(path.join(dir!, file), 'utf8');
      if (!/:\s*Capability\s*=\s*\{/.test(src)) continue;
      const name = src.match(/name:\s*'([a-z_]+)'/)?.[1];
      const policy = src.match(/default_policy:\s*'([a-z_]+)'/)?.[1];
      expect(name, `no capability name in ${file}`).toBeTruthy();
      expect(policy, `no default_policy in ${file}`).toBeTruthy();
      seen++;
      if (policy === 'approval_required') found.add(name!);
    }
    expect(seen).toBe(16);
    expect([...found].sort()).toEqual([...SUBSTRATE_APPROVAL_REQUIRED_CAPABILITIES].sort());
  });
});

// ---------------------------------------------------------------------------
// Principal — 'operator' vs 'human'.
// ---------------------------------------------------------------------------

describe('principalMayExecute', () => {
  it('an OPERATOR principal gets the full table, denials included', () => {
    for (const action of OPERATOR_DENIED_SUBSTRATE_ACTIONS) {
      expect(principalMayExecute('operator', 'manage_substrate', { action })).toBe(false);
    }
    expect(principalMayExecute('operator', 'manage_billing', {})).toBe(false);
    expect(principalMayExecute('operator', 'manage_substrate', { action: 'list_actions' })).toBe(true);
    // 'approval' is executable — executeOnce only ever runs a resolved approval.
    expect(principalMayExecute('operator', 'manage_substrate', { action: 'create_rule' })).toBe(true);
  });

  it('a HUMAN principal is not bound by the agent-specific action denials', () => {
    // This is precisely what makes the propose -> human-approves -> native
    // substrate approve() bridge possible while `approve` stays denied to the
    // operator. Deleting `approve` from the denied set instead would restore
    // agent self-approval.
    expect(principalMayExecute('human', 'manage_substrate', { action: 'approve', action_id: 'act_1' })).toBe(true);
    expect(principalMayExecute('human', 'manage_substrate', { action: 'reject', action_id: 'act_1' })).toBe(true);
    expect(principalMayExecute('operator', 'manage_substrate', { action: 'approve', action_id: 'act_1' })).toBe(false);
  });

  it('a HUMAN principal is still confined to the operator TOOL surface', () => {
    for (const name of ['manage_billing', 'manage_app', 'manage_api_keys', 'seed_database', 'not_a_real_tool']) {
      expect(principalMayExecute('human', name, {})).toBe(false);
    }
    expect(principalMayExecute('human', 'manage_substrate', { action: 'propose' })).toBe(true);
  });

  it('an unknown principal fails closed', () => {
    for (const bogus of [undefined, null, '', 'admin', 'Operator']) {
      expect(principalMayExecute(bogus as any, 'manage_substrate', { action: 'list_actions' })).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Enumeration guard: every advertised substrate action has a DELIBERATE verdict.
//
// `approve` sat on the operator's surface through three review rounds because
// the MCP tool advertises an action list and nothing cross-checked it against
// this policy table. That class of bug — a capability surface growing past a
// policy table that does not know about it — recurs every time somebody adds a
// substrate action.
//
// Same cross-repo limitation as the capability drift guard above: the MCP tool
// lives in the internal monorepo (cloud/overlays/substrate/mcp-tools), which is
// not a dependency of this OSS package, so this test skips in a standalone OSS
// checkout. And since no CI runs these tests anywhere today, it only fires on a
// manual local run from a monorepo checkout.
// ---------------------------------------------------------------------------

function findManageSubstrateTool(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'cloud', 'overlays', 'substrate', 'mcp-tools', 'manage-substrate.ts');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The `action` z.enum, verbatim from the MCP tool definition. */
function readAdvertisedActions(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const block = src.match(/action:\s*z\.enum\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('could not locate the `action: z.enum([...])` block in manage-substrate.ts');
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('enumeration guard — manage_substrate actions vs the operator policy table', () => {
  const file = findManageSubstrateTool();

  it.skipIf(file === null)('every advertised action has an explicit verdict', () => {
    const actions = readAdvertisedActions(file!);

    // Sanity: the parse actually found the surface, not an empty match.
    expect(actions.length).toBeGreaterThan(20);
    expect(actions).toContain('approve');
    expect(actions).toContain('propose');
    expect(new Set(actions).size).toBe(actions.length);

    const unclassified = actions.filter(
      (a) =>
        a !== 'propose' && // verdict is derived per-capability, not fixed
        !OPERATOR_DENIED_SUBSTRATE_ACTIONS.has(a) &&
        !OPERATOR_APPROVAL_SUBSTRATE_ACTIONS.has(a) &&
        !OPERATOR_ALLOWED_SUBSTRATE_ACTIONS.has(a),
    );
    expect(
      unclassified,
      `manage_substrate advertises action(s) with no verdict in operator-policy.ts: ${unclassified.join(', ')}. ` +
        'Classify each one — OPERATOR_ALLOWED_/APPROVAL_/DENIED_SUBSTRATE_ACTIONS — rather than letting it ' +
        'fall through to the allow floor unexamined.',
    ).toEqual([]);
  });

  it.skipIf(file === null)('the policy table does not classify actions the tool does not advertise', () => {
    // The mirror direction: a stale entry is a sign the surface moved.
    const advertised = new Set(readAdvertisedActions(file!));
    const classified = [
      ...OPERATOR_DENIED_SUBSTRATE_ACTIONS,
      ...OPERATOR_APPROVAL_SUBSTRATE_ACTIONS,
      ...OPERATOR_ALLOWED_SUBSTRATE_ACTIONS,
    ];
    expect(classified.filter((a) => !advertised.has(a))).toEqual([]);
  });

  it('the three verdict sets are mutually disjoint', () => {
    const all = [
      ...OPERATOR_DENIED_SUBSTRATE_ACTIONS,
      ...OPERATOR_APPROVAL_SUBSTRATE_ACTIONS,
      ...OPERATOR_ALLOWED_SUBSTRATE_ACTIONS,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('each set actually produces the verdict it claims', () => {
    for (const action of OPERATOR_DENIED_SUBSTRATE_ACTIONS) {
      expect(operatorPolicyFor('manage_substrate', { action })).toBe('deny');
    }
    for (const action of OPERATOR_APPROVAL_SUBSTRATE_ACTIONS) {
      expect(operatorPolicyFor('manage_substrate', { action })).toBe('approval');
    }
    for (const action of OPERATOR_ALLOWED_SUBSTRATE_ACTIONS) {
      expect(operatorPolicyFor('manage_substrate', { action })).toBe('allow');
    }
  });
});
