/**
 * SUFFICIENCY GUARD — every tool the operator can reach has a DELIBERATE tier.
 *
 * The other operator-policy tests prove the table is ENFORCED. Nothing proved
 * it was SUFFICIENT, and that gap produced both of the bugs this file exists
 * to prevent:
 *
 *  1. The empty-intersection bug: a server-side allowlist in tool-bridge.ts and
 *     `sensitivityFor` in tool-catalog.ts drifted until no tool appeared in
 *     both, so every approval the operator could create named a tool the bridge
 *     refused to run.
 *
 *  2. The six-tool gap: the operator's allowlist covered six tools out of the
 *     catalog's forty-two. It could read an app's data and change nothing —
 *     for anything touching the business a substrate memo was its only verb.
 *     The allowlist's own comment justified three deliberate exclusions and was
 *     silent on the other thirty. Nobody noticed for two weeks.
 *
 * Both are the same shape: a surface grew past a policy table that did not know
 * about it. The fix for the CLASS is this file. A tool in the catalog with no
 * entry in OPERATOR_TOOL_TIERS FAILS THE BUILD — it does not warn, and it does
 * not quietly resolve by fallback. The runtime fallback
 * (OPERATOR_UNLISTED_TOOL_TIER = 'approval') exists so the failure direction is
 * safe, NOT so that omission is acceptable; a test that accepted the fallback
 * would prove nothing, since the fallback answers for every string.
 *
 * Unlike the cross-repo drift guards in operator-policy.test.ts, this file has
 * no dependency on the internal monorepo checkout. It never skips.
 */
import { describe, it, expect } from 'vitest';

import {
  OPERATOR_TOOL_TIERS,
  OPERATOR_TOOL_SURFACE,
  OPERATOR_UNLISTED_TOOL_TIER,
  OPERATOR_LOCAL_TOOLS,
  operatorToolTier,
  operatorPolicyFor,
} from '../operator-policy.js';
import { getToolCatalog } from '../tool-catalog.js';

/** Every tool the operator can reach: the catalog, plus the loop-internal set. */
function reachableTools(): string[] {
  return [...new Set([...getToolCatalog().map((t) => t.name), ...OPERATOR_LOCAL_TOOLS])];
}

describe('sufficiency — every reachable tool has an explicit tier', () => {
  it('the catalog is actually populated (the guard must not pass vacuously)', () => {
    // If getToolCatalog() ever returns [] — a bad mock, a broken import — the
    // assertion below would pass while proving nothing. Pin the floor.
    expect(reachableTools().length).toBeGreaterThan(30);
  });

  it('no tool resolves by fallback: each has its OWN entry in OPERATOR_TOOL_TIERS', () => {
    const missing = reachableTools().filter((name) => !OPERATOR_TOOL_TIERS.has(name));
    expect(
      missing,
      `Tool(s) reachable by the operator with no explicit tier in operator-policy.ts: ${missing.join(', ')}.\n` +
        "Add each one to OPERATOR_TOOL_TIERS as 'allow' or 'approval'. Do NOT rely on the " +
        "OPERATOR_UNLISTED_TOOL_TIER fallback — it is the safe failure direction, not a classification. " +
        'This is the guard that would have caught the six-tool gap (2026-08-07).',
    ).toEqual([]);
  });

  it('every entry names a tool that actually exists (the mirror direction)', () => {
    // A stale entry means the catalog moved and this table did not follow.
    const reachable = new Set(reachableTools());
    const stale = [...OPERATOR_TOOL_TIERS.keys()].filter((name) => !reachable.has(name));
    expect(
      stale,
      `OPERATOR_TOOL_TIERS classifies tool(s) no longer in the catalog: ${stale.join(', ')}.`,
    ).toEqual([]);
  });

  it('every tier value is one of the two tiers — there is no tool-level deny', () => {
    for (const [name, tier] of OPERATOR_TOOL_TIERS) {
      expect(['allow', 'approval'], `${name} has tier "${tier}"`).toContain(tier);
    }
  });

  it('OPERATOR_TOOL_SURFACE is derived from the table, not written out twice', () => {
    expect([...OPERATOR_TOOL_SURFACE].sort()).toEqual([...OPERATOR_TOOL_TIERS.keys()].sort());
  });

  it('both loop-internal tools are classified', () => {
    for (const name of OPERATOR_LOCAL_TOOLS) {
      expect(OPERATOR_TOOL_TIERS.has(name), `${name} is not in OPERATOR_TOOL_TIERS`).toBe(true);
    }
  });
});

describe('deny-by-default — an unlisted tool never reaches the unsupervised tier', () => {
  it('the fallback tier is approval, not allow', () => {
    expect(OPERATOR_UNLISTED_TOOL_TIER).toBe('approval');
  });

  it('a name with no entry resolves to approval', () => {
    for (const name of ['', 'not_a_real_tool', 'manage_something_added_next_week', 'MANAGE_APP']) {
      expect(operatorToolTier(name), name).toBe('approval');
      expect(operatorPolicyFor(name, {}), name).toBe('approval');
    }
  });

  it('an unlisted tool is NOT auto-allowed just because the tier map is a Map', () => {
    // Guards against a Map/object mix-up where prototype keys answer.
    for (const name of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(operatorToolTier(name), name).toBe('approval');
    }
  });
});

describe('the allow tier is the spec list, nothing more', () => {
  // Pinned from docs/superpowers/specs/2026-08-07-operator-full-tool-access.md.
  // Widening this is a spec change, and this test is where that decision has to
  // be made deliberately rather than by adding a line to the table.
  const SPEC_ALLOW = [
    'butterbase_docs',
    'list_regions',
    'select_rows',
    'query_audit_logs',
    'rag_query',
    'manage_people',
    'manage_substrate',
    'run_sandbox_code',
    'update_operator_scratchpad',
    // NOT in the spec's `allow` code block, and deliberately allow anyway. The
    // spec's own "Accepted risks" section, item 3, says "manage_integrations
    // remains ungated (accepted 2026-08-05, re-confirmed 2026-08-06)" and
    // couples that verdict to run_sandbox_code's. The two sections disagree;
    // the risk section is the one that states a decision and a date, so it
    // wins. Recorded here rather than silently, because gating it would be the
    // more conservative reading and somebody will want to know this was seen.
    'manage_integrations',
  ];

  it('exactly these tools are allow-tier', () => {
    const actual = [...OPERATOR_TOOL_TIERS.entries()]
      .filter(([, tier]) => tier === 'allow')
      .map(([name]) => name);
    expect(actual.sort()).toEqual([...SPEC_ALLOW].sort());
  });

  it('everything else in the catalog is approval-tier', () => {
    const allow = new Set(SPEC_ALLOW);
    for (const name of reachableTools()) {
      if (allow.has(name)) continue;
      expect(operatorToolTier(name), `${name} should be approval-tier`).toBe('approval');
    }
  });

  it('the irreversible tools named in the accepted-risk section are all gated', () => {
    // Spec "Accepted risks": these are the ones a yolo org can reach
    // unsupervised, so if any of them ever drifted to 'allow' the gate would be
    // gone for NON-yolo orgs too. That is the failure this pins.
    for (const name of [
      'manage_api_keys',
      'manage_billing',
      'manage_app',
      'manage_repo',
      'manage_schema',
      'manage_migrations',
      'seed_database',
    ]) {
      expect(operatorToolTier(name), name).toBe('approval');
      expect(operatorPolicyFor(name, {}), name).toBe('approval');
    }
  });
});
