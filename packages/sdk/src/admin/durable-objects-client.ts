import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type {
  DurableObjectClass,
  DurableObjectUsage,
  RegisterDurableObjectParams,
} from './types.js';

export class AdminDurableObjectsClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async register(params: RegisterDurableObjectParams): Promise<ButterbaseResponse<DurableObjectClass>> {
    try {
      const data = await this.client.request<DurableObjectClass>(
        'POST', `/v1/${this.client.appId}/durable-objects`, params
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async list(): Promise<ButterbaseResponse<{ durable_objects: DurableObjectClass[] }>> {
    try {
      const data = await this.client.request<{ durable_objects: DurableObjectClass[] }>(
        'GET', `/v1/${this.client.appId}/durable-objects`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async get(name: string): Promise<ButterbaseResponse<DurableObjectClass>> {
    try {
      const data = await this.client.request<DurableObjectClass>(
        'GET', `/v1/${this.client.appId}/durable-objects/${name}`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async delete(name: string): Promise<ButterbaseResponse<{ deleted: boolean; name: string }>> {
    try {
      const data = await this.client.request<{ deleted: boolean; name: string }>(
        'DELETE', `/v1/${this.client.appId}/durable-objects/${name}`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async getUsage(name: string): Promise<ButterbaseResponse<DurableObjectUsage>> {
    try {
      const data = await this.client.request<DurableObjectUsage>(
        'GET', `/v1/${this.client.appId}/durable-objects/${name}/usage`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async listEnv(): Promise<ButterbaseResponse<{ keys: string[] }>> {
    try {
      const data = await this.client.request<{ keys: string[] }>(
        'GET', `/v1/${this.client.appId}/durable-objects/env`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async setEnv(key: string, value: string): Promise<ButterbaseResponse<{ key: string; redeployed: boolean }>> {
    try {
      const data = await this.client.request<{ key: string; redeployed: boolean }>(
        'PUT', `/v1/${this.client.appId}/durable-objects/env/${key}`, { value }
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async deleteEnv(key: string): Promise<ButterbaseResponse<{ deleted: boolean; key: string; redeployed: boolean }>> {
    try {
      const data = await this.client.request<{ deleted: boolean; key: string; redeployed: boolean }>(
        'DELETE', `/v1/${this.client.appId}/durable-objects/env/${key}`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
