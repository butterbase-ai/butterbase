import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type {
  PlatformBillingStatus, TopupRequest, SpendingCap, PlatformUsageOptions,
} from './types.js';

export class AdminPlatformBillingClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async getStatus(): Promise<ButterbaseResponse<PlatformBillingStatus>> {
    try {
      const data = await this.client.request<PlatformBillingStatus>('GET', '/dashboard/billing');
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async openPortal(): Promise<ButterbaseResponse<{ url: string }>> {
    try {
      const data = await this.client.request<{ url: string }>('POST', '/dashboard/billing/portal');
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async topup(req: TopupRequest): Promise<ButterbaseResponse<{ checkout_url: string }>> {
    try {
      const data = await this.client.request<{ checkout_url: string }>(
        'POST', '/dashboard/billing/topup', req,
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async getSpendingCap(): Promise<ButterbaseResponse<SpendingCap | null>> {
    try {
      const data = await this.client.request<SpendingCap | null>('GET', '/dashboard/billing/spending-cap');
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async setSpendingCap(cap: SpendingCap): Promise<ButterbaseResponse<SpendingCap>> {
    try {
      const data = await this.client.request<SpendingCap>(
        'PUT', '/dashboard/billing/spending-cap', cap,
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async listPlans(): Promise<ButterbaseResponse<{ plans: any[] }>> {
    try {
      const data = await this.client.request<{ plans: any[] }>('GET', '/dashboard/plans');
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async getUsage(opts: PlatformUsageOptions = {}): Promise<ButterbaseResponse<Record<string, number>>> {
    try {
      const q = new URLSearchParams();
      if (opts.startDate) q.set('startDate', opts.startDate);
      if (opts.endDate) q.set('endDate', opts.endDate);
      if (opts.meterType) q.set('meterType', opts.meterType);
      const qs = q.toString();
      const data = await this.client.request<Record<string, number>>(
        'GET', `/dashboard/usage${qs ? `?${qs}` : ''}`,
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
