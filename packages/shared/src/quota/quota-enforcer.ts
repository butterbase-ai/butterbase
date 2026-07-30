// Use Web Crypto (globalThis.crypto) instead of importing from 'node:crypto'
// so this module bundles cleanly in browsers, Sandpack, and Workers alongside
// Node ≥19 (which exposes the same global). `randomUUID` is required to be
// available on globalThis.crypto by the Web Crypto spec.
const randomUUID = (): string => globalThis.crypto.randomUUID();

export type QuotaKind = 'ai_credits' | 'function_invocations' | 'storage_gb_hours' | 'bandwidth_gb';

export interface LeaseRequest {
  kind: QuotaKind;
  estimatedUsdCost?: number;
}

export interface Lease {
  granted: boolean;
  leaseId: string;
  budgetUsd: number;
  expiresAt: Date;
  reason?: string;
}

export interface SettleParams {
  actualUsdSpent: number;
}

export interface QuotaEnforcer {
  acquireLease(userId: string, req: LeaseRequest): Promise<Lease>;
  settleLease(leaseId: string, params: SettleParams): Promise<void>;
  getRemaining(userId: string, kind: QuotaKind): Promise<number>;
}

export class UnlimitedQuotaEnforcer implements QuotaEnforcer {
  async acquireLease(_userId: string, _req: LeaseRequest): Promise<Lease> {
    return {
      granted: true,
      leaseId: randomUUID(),
      budgetUsd: Number.POSITIVE_INFINITY,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
  }
  async settleLease(_leaseId: string, _params: SettleParams): Promise<void> {}
  async getRemaining(_userId: string, _kind: QuotaKind): Promise<number> {
    return Number.POSITIVE_INFINITY;
  }
}
