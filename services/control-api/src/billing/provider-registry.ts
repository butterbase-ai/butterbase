import { NoopBillingProvider, type BillingProvider } from '@butterbase/shared';

let registered: BillingProvider | null = null;

export function setBillingProvider(provider: BillingProvider | null): void {
  registered = provider;
}

export function getBillingProvider(): BillingProvider {
  return registered ?? new NoopBillingProvider();
}
