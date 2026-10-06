/**
 * `yolo_mode` — the per-org pre-authorisation of the 'approval' tier.
 *
 * Three properties are load-bearing and each has a test here, because each one
 * is a way the flag could quietly become a bypass of something it must not
 * bypass:
 *
 *  1. It upgrades 'approval' to 'allow' and NOTHING ELSE.
 *  2. It cannot reach 'deny' — the substrate self-approval guard survives it.
 *  3. Absent, unknown or non-boolean means GATED. Only a literal `true` opens
 *     it, in the policy table and in the reader that fetches it.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  operatorPolicyFor,
  operatorPolicyForOrg,
  operatorRequiresApproval,
  OPERATOR_DENIED_SUBSTRATE_ACTIONS,
  OPERATOR_APPROVAL_SUBSTRATE_ACTIONS,
  OPERATOR_TOOL_TIERS,
} from '../operator-policy.js';
import { extractYoloMode, readOperatorYoloMode } from '../operator-yolo.js';

const YOLO = { yoloMode: true };
const GATED = { yoloMode: false };

describe('yolo_mode upgrades approval to allow', () => {
  it('gated tools execute unsupervised', () => {
    for (const name of ['invoke_function', 'insert_row', 'manage_function', 'manage_schema']) {
      expect(operatorPolicyFor(name, {}), name).toBe('approval');
      expect(operatorPolicyFor(name, {}, YOLO), name).toBe('allow');
      expect(operatorRequiresApproval(name, {}, YOLO), name).toBe(false);
    }
  });

  it('a propose of an approval_required capability auto-approves', () => {
    const args = { action: 'propose', capability: 'send_email_draft' };
    expect(operatorPolicyFor('manage_substrate', args)).toBe('approval');
    expect(operatorPolicyFor('manage_substrate', args, YOLO)).toBe('allow');
  });

  it('the oversight-weakening substrate actions are approval-tier, so yolo covers them too', () => {
    // Deliberate, and recorded: the spec has two tiers and no third category.
    // Pinned so that if somebody later decides rule mutations should resist
    // yolo, they change this test knowingly rather than discovering it live.
    for (const action of OPERATOR_APPROVAL_SUBSTRATE_ACTIONS) {
      expect(operatorPolicyFor('manage_substrate', { action }), action).toBe('approval');
      expect(operatorPolicyFor('manage_substrate', { action }, YOLO), action).toBe('allow');
    }
  });

  it('already-allow tools are unchanged', () => {
    for (const [name, tier] of OPERATOR_TOOL_TIERS) {
      if (tier !== 'allow') continue;
      expect(operatorPolicyFor(name, {}, YOLO), name).toBe('allow');
      expect(operatorPolicyFor(name, {}, GATED), name).toBe('allow');
    }
  });
});

describe('yolo_mode CANNOT reach deny', () => {
  it('the substrate self-approval guard survives every setting of the flag', () => {
    for (const action of OPERATOR_DENIED_SUBSTRATE_ACTIONS) {
      for (const ctx of [undefined, GATED, YOLO]) {
        expect(operatorPolicyFor('manage_substrate', { action }, ctx), `${action} / ${JSON.stringify(ctx)}`).toBe('deny');
      }
    }
  });

  it('approve and reject specifically — the gate that makes every other gate real', () => {
    expect(operatorPolicyFor('manage_substrate', { action: 'approve', action_id: 'act_1' }, YOLO)).toBe('deny');
    expect(operatorPolicyFor('manage_substrate', { action: 'reject', action_id: 'act_1' }, YOLO)).toBe('deny');
  });

  it('set_yolo stays denied — the operator cannot switch this on for itself', () => {
    expect(operatorPolicyFor('manage_substrate', { action: 'set_yolo', yolo_mode: true }, YOLO)).toBe('deny');
  });

  it('unreadable args stay denied', () => {
    for (const bad of ['nonsense', '[]', '42', { action: 42 }]) {
      expect(operatorPolicyFor('manage_substrate', bad, YOLO)).toBe('deny');
    }
  });

  it('the cross-org guard outranks it', () => {
    expect(operatorPolicyForOrg('select_rows', { org_id: 'org_b' }, 'org_a', YOLO)).toBe('deny');
    expect(operatorPolicyForOrg('invoke_function', { org_id: 'org_b' }, 'org_a', YOLO)).toBe('deny');
  });
});

describe('absent or malformed means GATED', () => {
  it('no context at all gates', () => {
    expect(operatorPolicyFor('invoke_function', {})).toBe('approval');
  });

  it('an empty context gates', () => {
    expect(operatorPolicyFor('invoke_function', {}, {})).toBe('approval');
  });

  it('only a literal true opens the gate — truthiness does not', () => {
    for (const bogus of ['true', 1, 'yes', {}, []]) {
      expect(operatorPolicyFor('invoke_function', {}, { yoloMode: bogus as never }), String(bogus)).toBe('approval');
    }
  });
});

describe('extractYoloMode — reads the flag out of whatever MCP wrapped it in', () => {
  it('reads the bare route body', () => {
    expect(extractYoloMode({ yolo_mode: true })).toBe(true);
    expect(extractYoloMode({ yolo_mode: false })).toBe(false);
  });

  it('reads it through the callMcpTool envelope', () => {
    expect(extractYoloMode({ ok: true, result: { yolo_mode: true } })).toBe(true);
  });

  it('reads it through MCP text content', () => {
    expect(
      extractYoloMode({
        ok: true,
        result: { content: [{ type: 'text', text: JSON.stringify({ yolo_mode: true }) }] },
      }),
    ).toBe(true);
  });

  it('a non-boolean yolo_mode does not open the gate', () => {
    for (const bogus of [{ yolo_mode: 'true' }, { yolo_mode: 1 }, { yolo_mode: null }]) {
      expect(extractYoloMode(bogus), JSON.stringify(bogus)).toBe(false);
    }
  });

  it('an absent flag, an error body, and junk all read as false', () => {
    for (const v of [undefined, null, {}, [], 'not json', 42, { ok: false, error: 'substrate not provisioned' }]) {
      expect(extractYoloMode(v), JSON.stringify(v)).toBe(false);
    }
  });

  it('does not recurse forever on a cyclic value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(extractYoloMode(cyclic)).toBe(false);
  });
});

describe('readOperatorYoloMode — never throws, fails to gated', () => {
  it('asks for get_settings and nothing else', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, result: { yolo_mode: true } });
    await expect(readOperatorYoloMode({ call }, 'jwt')).resolves.toBe(true);
    expect(call).toHaveBeenCalledWith('manage_substrate', { action: 'get_settings' }, 'jwt');
  });

  it('an MCP failure gates rather than opening', async () => {
    const call = vi.fn().mockRejectedValue(new Error('MCP unreachable'));
    await expect(readOperatorYoloMode({ call }, 'jwt')).resolves.toBe(false);
  });

  it('an unprovisioned substrate gates', async () => {
    const call = vi.fn().mockResolvedValue({ ok: false, error: 'substrate not provisioned' });
    await expect(readOperatorYoloMode({ call }, 'jwt')).resolves.toBe(false);
  });
});
