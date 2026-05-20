import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type { RlsPolicy, CreatePolicyParams } from './types.js';

export class AdminRlsClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async enable(tableName: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<any>('POST', `/v1/${this.client.appId}/rls/enable`, { table_name: tableName });
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async createPolicy(params: CreatePolicyParams): Promise<ButterbaseResponse<RlsPolicy>> {
    try {
      const data = await this.client.request<RlsPolicy>('POST', `/v1/${this.client.appId}/rls/policies`, params);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async createUserIsolation(
    tableName: string,
    userColumn: string = 'user_id',
    options?: { publicReadColumn?: string },
  ): Promise<ButterbaseResponse<RlsPolicy>> {
    try {
      const body: Record<string, unknown> = {
        table_name: tableName,
        user_column: userColumn,
      };
      if (options?.publicReadColumn) body.public_read_column = options.publicReadColumn;
      const data = await this.client.request<RlsPolicy>('POST', `/v1/${this.client.appId}/rls`, body);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async list(): Promise<ButterbaseResponse<RlsPolicy[]>> {
    try {
      const raw = await this.client.request<any[]>('GET', `/v1/${this.client.appId}/rls`);
      const normalized: RlsPolicy[] = (raw ?? []).map((p) => ({
        table_name: p.table_name ?? p.tablename,
        policy_name: p.policy_name ?? p.policyname,
        command: p.command ?? p.cmd,
        role: p.role ?? (Array.isArray(p.roles) ? p.roles.join(',') : p.roles),
        restrictive: p.restrictive ?? (p.permissive === 'RESTRICTIVE'),
        using_expression: p.using_expression ?? p.qual,
        with_check_expression: p.with_check_expression ?? p.with_check,
      }));
      return { data: normalized, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async delete(tableName: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<any>('DELETE', `/v1/${this.client.appId}/rls/${tableName}`);
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async deletePolicy(tableName: string, policyName: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<any>(
        'DELETE',
        `/v1/${this.client.appId}/rls/${tableName}/${policyName}`,
      );
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
