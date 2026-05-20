import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type { ApiKey, ApiKeySummary, GenerateApiKeyParams } from './types.js';

export class AdminApiKeysClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async generate(name: string): Promise<ButterbaseResponse<ApiKey>>;
  async generate(params: GenerateApiKeyParams): Promise<ButterbaseResponse<ApiKey>>;
  async generate(p: string | GenerateApiKeyParams): Promise<ButterbaseResponse<ApiKey>> {
    const body = typeof p === 'string' ? { name: p } : p;
    try {
      const data = await this.client.request<ApiKey>('POST', '/api-keys', body);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async list(): Promise<ButterbaseResponse<ApiKeySummary[]>> {
    try {
      const data = await this.client.request<ApiKeySummary[]>('GET', '/api-keys');
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async revoke(keyId: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<any>('DELETE', `/api-keys/${keyId}`);
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
