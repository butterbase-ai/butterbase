import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type { AuditLogPage, AuditLogQueryOptions } from './types.js';

export class AdminAuditLogsClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async query(options: AuditLogQueryOptions = {}): Promise<ButterbaseResponse<AuditLogPage>> {
    try {
      const params = new URLSearchParams();
      const map: Record<string, string | undefined> = {
        category: options.category,
        event_type: options.eventType,
        action: options.action,
        resource_type: options.resourceType,
        resource_id: options.resourceId,
        actor_id: options.actorId,
        from: options.from,
        to: options.to,
        limit: options.limit !== undefined ? String(options.limit) : undefined,
        offset: options.offset !== undefined ? String(options.offset) : undefined,
      };
      for (const [k, v] of Object.entries(map)) if (v !== undefined) params.set(k, v);
      const qs = params.toString();
      const path = `/v1/${this.client.appId}/audit-logs${qs ? `?${qs}` : ''}`;
      const data = await this.client.request<AuditLogPage>('GET', path);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
