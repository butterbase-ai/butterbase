// packages/sdk/src/integrations/integrations-client.ts
import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type {
  IntegrationConfig,
  AvailableIntegration,
  ConnectedAccount,
  IntegrationTool,
  ToolResult,
  ConfigureOptions,
  ConnectOptions,
  ConnectResult,
  ListAvailableOptions,
} from './types.js';

export class IntegrationsClient {
  constructor(private client: ButterbaseClient) {}

  // --- Admin methods (API key auth) ---

  /** Enable a toolkit for this app. Requires API key auth. */
  async configure(
    toolkit: string,
    options?: ConfigureOptions,
  ): Promise<ButterbaseResponse<IntegrationConfig>> {
    try {
      const body: Record<string, unknown> = { toolkit };
      if (options?.scopes) body.scopes = options.scopes;
      if (options?.displayName) body.displayName = options.displayName;

      const data = await this.client.request<IntegrationConfig>(
        'POST',
        `/v1/${this.client.appId}/integrations/configure`,
        body
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /** List available toolkits. Pass `search` to query the full integrations catalog. */
  async listAvailable(
    options?: ListAvailableOptions,
  ): Promise<ButterbaseResponse<AvailableIntegration[]>> {
    try {
      const params = new URLSearchParams();
      if (options?.search) params.set('search', options.search);
      if (options?.curated !== undefined) params.set('curated', String(options.curated));
      const query = params.toString() ? `?${params}` : '';

      const data = await this.client.request<{ integrations: AvailableIntegration[] }>(
        'GET',
        `/v1/${this.client.appId}/integrations/available${query}`
      );
      return { data: data.integrations, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /** Get all enabled integration configs for this app. Requires API key auth. */
  async getConfig(): Promise<ButterbaseResponse<IntegrationConfig[]>> {
    try {
      const data = await this.client.request<{ integrations: IntegrationConfig[] }>(
        'GET',
        `/v1/${this.client.appId}/integrations/config`
      );
      return { data: data.integrations, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /** Disable a toolkit. Requires API key auth. */
  async disable(toolkit: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<void>(
        'DELETE',
        `/v1/${this.client.appId}/integrations/configure/${encodeURIComponent(toolkit)}`
      );
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  // --- End-user methods (JWT auth) ---

  /** Generate an OAuth URL for an end-user to connect their account. Redirect the user to `result.authUrl`. */
  async connect(
    toolkit: string,
    options: ConnectOptions,
  ): Promise<ButterbaseResponse<ConnectResult>> {
    try {
      const data = await this.client.request<ConnectResult>(
        'POST',
        `/v1/${this.client.appId}/integrations/connect`,
        { toolkit, redirectUrl: options.redirectUrl }
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /** Disconnect an end-user's connected account. */
  async disconnect(connectionId: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<void>(
        'DELETE',
        `/v1/${this.client.appId}/integrations/connections/${encodeURIComponent(connectionId)}`
      );
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /** List connected accounts. With JWT auth: returns current user's connections only. With API key: returns all connections for the app. */
  async listConnections(): Promise<ButterbaseResponse<ConnectedAccount[]>> {
    try {
      const data = await this.client.request<{ connections: ConnectedAccount[] }>(
        'GET',
        `/v1/${this.client.appId}/integrations/connections`
      );
      return { data: data.connections, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  // --- Tool execution (JWT or API key) ---

  /** List executable tools for a toolkit. Returns tool names, descriptions, and parameter schemas. */
  async getTools(toolkit?: string): Promise<ButterbaseResponse<IntegrationTool[]>> {
    try {
      const query = toolkit ? `?toolkit=${encodeURIComponent(toolkit)}` : '';
      const data = await this.client.request<{ tools: IntegrationTool[] }>(
        'GET',
        `/v1/${this.client.appId}/integrations/tools${query}`
      );
      return { data: data.tools, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /** Execute a tool using the authenticated user's connected account. */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ButterbaseResponse<ToolResult>> {
    try {
      const data = await this.client.request<ToolResult>(
        'POST',
        `/v1/${this.client.appId}/integrations/execute`,
        { toolName, params }
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  // --- Service-level (API key only) ---

  /** Scope tool execution to a specific user. Use in cron jobs, webhooks, or admin contexts where you act on behalf of a user. */
  asUser(userId: string): UserScopedIntegrationsClient {
    return new UserScopedIntegrationsClient(this.client, userId);
  }
}

/**
 * Scoped client for executing integration actions on behalf of a specific user.
 * Used in service-level contexts (cron jobs, webhooks).
 */
export class UserScopedIntegrationsClient {
  constructor(
    private client: ButterbaseClient,
    private userId: string,
  ) {}

  async execute(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ButterbaseResponse<ToolResult>> {
    try {
      const data = await this.client.request<ToolResult>(
        'POST',
        `/v1/${this.client.appId}/integrations/execute`,
        { toolName, params, userId: this.userId }
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async getTools(toolkit?: string): Promise<ButterbaseResponse<IntegrationTool[]>> {
    try {
      const query = toolkit ? `?toolkit=${encodeURIComponent(toolkit)}` : '';
      const data = await this.client.request<{ tools: IntegrationTool[] }>(
        'GET',
        `/v1/${this.client.appId}/integrations/tools${query}`
      );
      return { data: data.tools, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
