import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type { RealtimeConfig, RealtimeTableResult } from './types.js';

export class AdminRealtimeClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async configure(tables: string[]): Promise<ButterbaseResponse<{ configured: RealtimeTableResult[] }>> {
    try {
      const data = await this.client.request<{ configured: RealtimeTableResult[] }>(
        'POST', `/v1/${this.client.appId}/realtime/configure`, { tables }
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async getConfig(): Promise<ButterbaseResponse<RealtimeConfig>> {
    try {
      const data = await this.client.request<RealtimeConfig>(
        'GET', `/v1/${this.client.appId}/realtime/config`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async disableTable(table: string): Promise<ButterbaseResponse<RealtimeTableResult>> {
    try {
      const data = await this.client.request<RealtimeTableResult>(
        'DELETE', `/v1/${this.client.appId}/realtime/${table}`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
