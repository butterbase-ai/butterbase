export type OperatorAccessPhase = 'activate' | 'run' | 'execute';

export type OperatorAccessInput = {
  organizationId: string;
  phase: OperatorAccessPhase;
  origin: 'operator' | 'office' | 'dashboard';
  actorUserId?: string;
  model?: string;
};

export type OperatorAccessDecision = {
  allowed: boolean;
  reason: string | null;
  approvalMode: 'standard' | 'consequential';
};

export interface OperatorAccessPolicy {
  evaluate(input: OperatorAccessInput): Promise<OperatorAccessDecision>;
}

let accessPolicy: OperatorAccessPolicy | null = null;

export function setOperatorAccessPolicy(policy: OperatorAccessPolicy | null): void {
  accessPolicy = policy;
}

export async function evaluateOperatorAccess(input: OperatorAccessInput): Promise<OperatorAccessDecision> {
  if (!accessPolicy) {
    return { allowed: true, reason: null, approvalMode: 'standard' };
  }
  try {
    return await accessPolicy.evaluate(input);
  } catch {
    return { allowed: false, reason: 'service_unavailable', approvalMode: 'consequential' };
  }
}

export function assertOperatorAccessPolicyReady(required: boolean): void {
  if (required && !accessPolicy) {
    throw new Error('Operator access policy is required but has not been registered');
  }
}
