import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type { SchemaDefinition, MigrationResult, Migration } from './types.js';

export class AdminSchemaClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async get(): Promise<ButterbaseResponse<any>> {
    try {
      const data = await this.client.request<any>('GET', `/v1/${this.client.appId}/schema`);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async apply(schema: SchemaDefinition, options?: { dryRun?: boolean; name?: string }): Promise<ButterbaseResponse<MigrationResult>> {
    try {
      const body: any = { schema };
      if (options?.dryRun) body.dry_run = true;
      if (options?.name) body.name = options.name;
      const data = await this.client.request<MigrationResult>('POST', `/v1/${this.client.appId}/schema/apply`, body);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async dryRun(schema: SchemaDefinition): Promise<ButterbaseResponse<MigrationResult>> {
    return this.apply(schema, { dryRun: true });
  }

  async migrations(): Promise<ButterbaseResponse<Migration[]>> {
    try {
      const data = await this.client.request<Migration[]>('GET', `/v1/${this.client.appId}/migrations`);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
