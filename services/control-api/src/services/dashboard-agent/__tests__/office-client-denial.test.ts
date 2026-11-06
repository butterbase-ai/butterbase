import { describe, expect, it } from 'vitest';
import { operatorPolicyFor, isOperatorToolAllowed, principalMayExecute } from '../operator-policy.js';
import { classifyOfficeTool } from '../office-tool-policy.js';
import { getToolCatalog } from '../tool-catalog.js';
import { executeOnce } from '../tool-bridge.js';
describe('external Office commands cannot authorize the agent itself', () => {
  it.each(['enable', 'pause', 'resume', 'approve', 'status', 'ask'])('denies forged manage_office %s at policy and dispatch boundaries', async action => {
    const args = { action, org_id: 'org' };
    expect(operatorPolicyFor('manage_office', args, { yoloMode: true })).toBe('deny');
    expect(classifyOfficeTool('manage_office', args)).toBe('deny');
    expect(isOperatorToolAllowed('manage_office')).toBe(false);
    for (const principal of ['operator', 'human'] as const) {
      expect(principalMayExecute(principal, 'manage_office', args)).toBe(false);
      // This fake pool throws on any DB access: refusal must precede replay/cache/execution.
      const pool = { connect: () => { throw new Error('must not touch DB'); } };
      expect(await executeOnce(pool as never, { approvalId: 'forged', name: 'manage_office', args, jwt: 'synthetic', orgId: 'org', principal })).toMatchObject({ ok: false });
    }
  });
  it('does not advertise the facade in the model tool catalog', () => {
    expect(getToolCatalog().some(tool => tool.name === 'manage_office')).toBe(false);
  });
});
