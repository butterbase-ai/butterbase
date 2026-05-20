import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type { AppMigration, SourceReplica } from './types.js';

export class AdminMigrationsClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async listRegions(): Promise<ButterbaseResponse<{ regions: string[] }>> {
    try {
      const data = await this.client.request<{ regions: string[] }>('GET', `/v1/regions`);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async move(appId: string, destRegion: string): Promise<ButterbaseResponse<{ migration_id: string; status: string }>> {
    try {
      const data = await this.client.request<{ migration_id: string; status: string }>(
        'POST', `/v1/apps/${appId}/move`, { dest_region: destRegion },
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async getStatus(appId: string, migrationId: string): Promise<ButterbaseResponse<AppMigration>> {
    try {
      const data = await this.client.request<AppMigration>(
        'GET', `/v1/apps/${appId}/migrations/${migrationId}`,
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async getActive(appId: string): Promise<ButterbaseResponse<{ migration: AppMigration | null }>> {
    try {
      const data = await this.client.request<{ migration: AppMigration | null }>(
        'GET', `/v1/apps/${appId}/migrations/active`,
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async abort(appId: string, migrationId: string): Promise<ButterbaseResponse<{ status: string }>> {
    try {
      const data = await this.client.request<{ status: string }>(
        'POST', `/v1/apps/${appId}/migrations/${migrationId}/abort`,
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async reverse(appId: string, migrationId: string): Promise<ButterbaseResponse<{ migrationId: string; path: string[] }>> {
    try {
      const data = await this.client.request<{ migrationId: string; path: string[] }>(
        'POST', `/v1/apps/${appId}/migrations/${migrationId}/reverse`,
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async listSourceReplicas(): Promise<ButterbaseResponse<{ source_replicas: SourceReplica[] }>> {
    try {
      const data = await this.client.request<{ source_replicas: SourceReplica[] }>('GET', `/v1/source-replicas`);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async tearDownSourceReplica(migrationId: string): Promise<ButterbaseResponse<{ status: 'torn_down' }>> {
    try {
      const data = await this.client.request<{ status: 'torn_down' }>(
        'DELETE', `/v1/source-replicas/${migrationId}`,
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
