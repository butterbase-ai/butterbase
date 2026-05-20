import { UnlimitedQuotaEnforcer, type QuotaEnforcer } from '@butterbase/shared';

let registered: QuotaEnforcer | null = null;

export function setQuotaEnforcer(enforcer: QuotaEnforcer | null): void {
  registered = enforcer;
}

export function getQuotaEnforcer(): QuotaEnforcer {
  return registered ?? new UnlimitedQuotaEnforcer();
}
