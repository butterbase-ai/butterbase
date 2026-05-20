import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type { OAuthConfig, OAuthConfigParams } from './types.js';

export class AdminOAuthClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async create(params: OAuthConfigParams): Promise<ButterbaseResponse<OAuthConfig>> {
    try {
      const data = await this.client.request<OAuthConfig>(
        'POST', `/v1/${this.client.appId}/auth/oauth-config`, params
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async list(): Promise<ButterbaseResponse<OAuthConfig[]>> {
    try {
      const data = await this.client.request<OAuthConfig[]>(
        'GET', `/v1/${this.client.appId}/auth/oauth-config`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async get(provider: string): Promise<ButterbaseResponse<OAuthConfig>> {
    try {
      const data = await this.client.request<OAuthConfig>(
        'GET', `/v1/${this.client.appId}/auth/oauth-config/${provider}`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async update(provider: string, updates: Partial<OAuthConfigParams>): Promise<ButterbaseResponse<OAuthConfig>> {
    try {
      const data = await this.client.request<OAuthConfig>(
        'PATCH', `/v1/${this.client.appId}/auth/oauth-config/${provider}`, updates
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async delete(provider: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<any>(
        'DELETE', `/v1/${this.client.appId}/auth/oauth-config/${provider}`
      );
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
