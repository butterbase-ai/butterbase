import { afterEach, describe, expect, it } from 'vitest';
import {
  assertOperatorAccessPolicyReady,
  evaluateOperatorAccess,
  setOperatorAccessPolicy,
} from '../operator-access-policy.js';

const input = {
  organizationId: 'org-one',
  phase: 'run' as const,
  origin: 'operator' as const,
};

afterEach(() => setOperatorAccessPolicy(null));

describe('operator access policy', () => {
  it('allows OSS work with standard approval when no provider is installed', async () => {
    setOperatorAccessPolicy(null);
    expect(await evaluateOperatorAccess(input)).toEqual({
      allowed: true, reason: null, approvalMode: 'standard',
    });
    expect(() => assertOperatorAccessPolicyReady(false)).not.toThrow();
  });

  it('uses the installed provider decision', async () => {
    setOperatorAccessPolicy({
      evaluate: async (actual) => {
        expect(actual).toEqual(input);
        return { allowed: false, reason: 'paid_plan_required', approvalMode: 'consequential' };
      },
    });
    expect(await evaluateOperatorAccess(input)).toEqual({
      allowed: false, reason: 'paid_plan_required', approvalMode: 'consequential',
    });
    expect(() => assertOperatorAccessPolicyReady(true)).not.toThrow();
  });

  it('denies new work when the installed provider fails', async () => {
    setOperatorAccessPolicy({ evaluate: async () => { throw new Error('database unavailable'); } });
    expect(await evaluateOperatorAccess(input)).toEqual({
      allowed: false, reason: 'service_unavailable', approvalMode: 'consequential',
    });
  });

  it('fails startup readiness when a provider is required but missing', () => {
    setOperatorAccessPolicy(null);
    expect(() => assertOperatorAccessPolicyReady(true)).toThrow();
  });
});
