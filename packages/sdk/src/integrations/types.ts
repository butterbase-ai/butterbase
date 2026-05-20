// packages/sdk/src/integrations/types.ts

/** An enabled toolkit configuration for an app. */
export interface IntegrationConfig {
  id: string;
  app_id: string;
  toolkit_slug: string;
  composio_auth_config_id: string;
  display_name: string | null;
  enabled: boolean;
  scopes: string[];
  created_at: string;
}

/** A toolkit available in the integrations catalog. */
export interface AvailableIntegration {
  toolkit: string;
  displayName: string;
  curated: boolean;
}

/** An end-user's connected account for a toolkit. */
export interface ConnectedAccount {
  id: string;
  app_user_id: string;
  toolkit_slug: string;
  status: 'active' | 'inactive' | 'expired';
  connected_at: string;
  last_used_at: string | null;
}

/** A tool available within an integration. */
export interface IntegrationTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Result of executing an integration tool. */
export interface ToolResult {
  successful: boolean;
  data: unknown;
  error?: string;
}

export interface ConfigureOptions {
  scopes?: string[];
  displayName?: string;
}

export interface ConnectOptions {
  redirectUrl: string;
}

export interface ConnectResult {
  authUrl: string;
  connectionRequestId: string;
}

export interface ListAvailableOptions {
  search?: string;
  curated?: boolean;
}
