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

  /**
   * Register a new custom domain.
   *
   * @param hostname e.g. 'app.example.com' or 'example.com' (apex)
   * @param validationMethod SSL DCV method:
   *   - 'http' (default): Cloudflare auto-validates via an HTTP challenge served from our zone.
   *     Convenient but does NOT work for apex hostnames on Cloudflare-hosted zones.
   *   - 'txt': Cloudflare emits a TXT record to add to DNS. Works in every case,
   *     including apex on a Cloudflare-proxied zone. Use this for any apex on Cloudflare DNS.
   */
  async add(
    hostname: string,
    validationMethod?: 'http' | 'txt',
  ): Promise<ButterbaseResponse<CustomDomainAddResult>> {
    try {
      const body: Record<string, unknown> = { hostname };
      if (validationMethod) body.validation_method = validationMethod;
      const data = await this.client.request<CustomDomainAddResult>(
        'POST', `/v1/${this.client.appId}/custom-domains`, body
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
