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
  SUBSTRATE_APPROVAL_REQUIRED_CAPABILITIES,
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

  it('tolerates missing / non-object args', () => {
    expect(operatorPolicyFor('manage_substrate', undefined)).toBe('allow');
    expect(operatorPolicyFor('manage_substrate', null)).toBe('allow');
    expect(operatorPolicyFor('manage_substrate', 'nonsense')).toBe('allow');
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
