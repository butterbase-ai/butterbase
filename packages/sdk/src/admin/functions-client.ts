import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type { DeployFunctionParams, FunctionDetails, FunctionSummary, FunctionLog, LogOptions } from './types.js';

export class AdminFunctionsClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async deploy(params: DeployFunctionParams): Promise<ButterbaseResponse<FunctionDetails>> {
    try {
      const data = await this.client.request<FunctionDetails>(
        'POST', `/v1/${this.client.appId}/functions`, params
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async list(): Promise<ButterbaseResponse<FunctionSummary[]>> {
    try {
      const data = await this.client.request<FunctionSummary[]>(
        'GET', `/v1/${this.client.appId}/functions`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async get(name: string): Promise<ButterbaseResponse<FunctionDetails>> {
    try {
      const data = await this.client.request<FunctionDetails>(
        'GET', `/v1/${this.client.appId}/functions/${name}`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async delete(name: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<any>('DELETE', `/v1/${this.client.appId}/functions/${name}`);
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async logs(name: string, options?: LogOptions): Promise<ButterbaseResponse<FunctionLog[]>> {
    try {
      const params = new URLSearchParams();
      if (options?.limit) params.set('limit', String(options.limit));
      if (options?.since) params.set('since', options.since);
      if (options?.level) params.set('level', options.level);
      if (options?.includeDeleted) params.set('include_deleted', 'true');
      const qs = params.toString();
      const path = `/v1/${this.client.appId}/functions/${name}/logs${qs ? `?${qs}` : ''}`;
      const data = await this.client.request<FunctionLog[]>('GET', path);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async updateEnv(name: string, vars: Record<string, string>): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<any>(
        'PATCH', `/v1/${this.client.appId}/functions/${name}/env`, { envVars: vars }
      );
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
