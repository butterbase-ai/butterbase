import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type { CustomDomain, CustomDomainAddResult, CustomDomainStatus } from './types.js';

export class AdminDomainsClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async list(): Promise<ButterbaseResponse<CustomDomain[]>> {
    try {
      const data = await this.client.request<CustomDomain[]>(
        'GET', `/v1/${this.client.appId}/custom-domains`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async add(hostname: string): Promise<ButterbaseResponse<CustomDomainAddResult>> {
    try {
      const data = await this.client.request<CustomDomainAddResult>(
        'POST', `/v1/${this.client.appId}/custom-domains`, { hostname }
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async getStatus(domainId: string): Promise<ButterbaseResponse<CustomDomainStatus>> {
    try {
      const data = await this.client.request<CustomDomainStatus>(
        'GET', `/v1/${this.client.appId}/custom-domains/${domainId}/status`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async verify(domainId: string): Promise<ButterbaseResponse<CustomDomainStatus>> {
    try {
      const data = await this.client.request<CustomDomainStatus>(
        'POST', `/v1/${this.client.appId}/custom-domains/${domainId}/verify`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async remove(domainId: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<void>(
        'DELETE', `/v1/${this.client.appId}/custom-domains/${domainId}`
      );
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
