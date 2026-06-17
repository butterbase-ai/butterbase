// services/mcp-server/src/tools/integrations.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiDelete, getBaseUrl, getHeaders } from '../api-client.js';

export function registerIntegrations(server: McpServer) {
  server.tool(
    'manage_integrations',
    `Manage third-party integrations for a Butterbase app (e.g., Gmail, Slack, Google Calendar).

Actions:
  - "configure":          Enable or manage a third-party integration toolkit for an app
  - "rotate_credentials": Swap in new BYO OAuth client_id/client_secret without dropping connected accounts
  - "disable":            Disable a configured integration toolkit
  - "list_available":     List available integrations that can be enabled (curated or full catalog)
  - "list_connected":     List connected integration accounts for an app
  - "list_tools":         List available tool actions for connected integrations
  - "execute_action":     Execute a tool action on a connected integration (e.g., send email, create event)

Parameters by action:
  configure:          { app_id, action: "configure", toolkit, scopes?, display_name?, oauth_credentials? }
  rotate_credentials: { app_id, action: "rotate_credentials", toolkit, oauth_credentials }
  disable:            { app_id, action: "disable", toolkit }
  list_available:     { app_id, action: "list_available", search? }
  list_connected:     { app_id, action: "list_connected" }
  list_tools:         { app_id, action: "list_tools", toolkit? }
  execute_action:     { app_id, action: "execute_action", tool_name, params?, user_id? }

Curated toolkits (first-class support, no BYO credentials needed):
  gmail, google-calendar, slack, google-sheets, notion, github, hubspot, outlook, google-drive, discord

Non-curated toolkits (Twitter, LinkedIn, Reddit, etc.) usually require BYO OAuth credentials.
Use list_available with search=<name> first to inspect requires_byo_credentials and auth_schemes.

Example — configure (curated, managed auth):
  Input:  { app_id: "app_abc123", action: "configure", toolkit: "gmail", scopes: ["gmail.send"] }
  Output: { id: "...", toolkit_slug: "gmail", enabled: true }

Example — configure (BYO OAuth credentials, e.g. Twitter/X):
  Input:  {
    app_id: "app_abc123", action: "configure", toolkit: "twitter",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    oauth_credentials: {
      client_id: "...",
      client_secret: "...",
      generic_id: "<Twitter App Bearer Token>",  // toolkit-specific extra field
      auth_scheme: "OAUTH2"
    }
  }
  Output: { id: "...", toolkit_slug: "twitter", enabled: true }

Example — rotate_credentials (after upstream OAuth client rotation):
  Input:  {
    app_id: "app_abc123", action: "rotate_credentials", toolkit: "twitter",
    oauth_credentials: { client_id: "new...", client_secret: "new..." }
  }
  Output: { id: "...", toolkit_slug: "twitter", enabled: true }

Example — list_available:
  Input:  { app_id: "app_abc123", action: "list_available", search: "twitter" }
  Output: { integrations: [{ toolkit: "twitter", displayName: "Twitter", curated: false, auth_schemes: ["OAUTH2"], requires_byo_credentials: true }, ...] }

Example — list_connected:
  Input:  { app_id: "app_abc123", action: "list_connected" }
  Output: { connections: [{ toolkit_slug: "gmail", status: "active", connected_at: "..." }, ...] }

Example — list_tools:
  Input:  { app_id: "app_abc123", action: "list_tools", toolkit: "gmail" }
  Output: { tools: [{ name: "GMAIL_SEND_EMAIL", description: "Send an email", parameters: {...} }, ...] }

Example — execute_action (send email):
  Input:  { app_id: "app_abc123", action: "execute_action", tool_name: "GMAIL_SEND_EMAIL", params: { to: "user@example.com", subject: "Hello", body: "World" } }
  Output: { successful: true, data: { messageId: "..." } }

Common errors:
  - INTEGRATIONS_NOT_CONFIGURED: Integration API key not set
  - INTEGRATIONS_BYO_CREDENTIALS_REQUIRED: Toolkit has no Composio-managed auth; pass oauth_credentials
  - INTEGRATIONS_UPSTREAM_ERROR: Composio rejected the auth config (bad slug or bad credentials)
  - INTEGRATIONS_NOT_CONNECTED: User hasn't connected this integration
  - INTEGRATIONS_EXECUTION_FAILED: Integration tool execution failed
  - RESOURCE_NOT_FOUND: App doesn't exist`,
    {
      action: z.enum(['configure', 'rotate_credentials', 'disable', 'list_available', 'list_connected', 'list_tools', 'execute_action'])
        .describe('The action to perform'),
      app_id: z.string().describe('The app ID (e.g. app_abc123def456)'),
      // configure / disable params
      toolkit: z.string().optional().describe('Integration toolkit slug (e.g. gmail, slack). Required for configure and disable.'),
      scopes: z.array(z.string()).optional().describe('OAuth scopes to request (configure only)'),
      display_name: z.string().optional().describe('Custom display name (configure only)'),
      oauth_credentials: z.object({
        client_id: z.string(),
        client_secret: z.string(),
        auth_scheme: z.enum([
          'OAUTH2', 'OAUTH1', 'API_KEY', 'BASIC', 'BILLCOM_AUTH', 'BEARER_TOKEN',
          'GOOGLE_SERVICE_ACCOUNT', 'NO_AUTH', 'BASIC_WITH_JWT', 'CALCOM_AUTH',
          'SERVICE_ACCOUNT', 'SAML', 'DCR_OAUTH', 'S2S_OAUTH2',
        ]).optional(),
      }).catchall(z.union([z.string(), z.number(), z.boolean()])).optional().describe('BYO OAuth credentials for non-curated toolkits (configure / rotate_credentials). Required fields vary by toolkit — pass any extras the toolkit needs (e.g. twitter requires `generic_id` as the App Bearer Token). Omit for curated toolkits.'),
      // list_available params
      search: z.string().optional().describe('Search query to find integrations by name (list_available only)'),
      // list_tools params (toolkit is already above, shared)
      // execute_action params
      tool_name: z.string().optional().describe('Integration tool slug (e.g. GMAIL_SEND_EMAIL). Required for execute_action.'),
      params: z.record(z.unknown()).optional().describe('Arguments for the tool action (execute_action only)'),
      user_id: z.string().optional().describe('Execute on behalf of a specific user, service-level only (execute_action only)'),
    },
    {
      title: 'Manage Integrations',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const { action, app_id } = args;
      const need = (cond: unknown, msg: string) =>
        cond ? null : { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };

      switch (action) {
        case 'configure': {
          const err = need(args.toolkit, '"toolkit" is required for the "configure" action.');
          if (err) return err;
          const res = await fetch(`${getBaseUrl()}/v1/${app_id}/integrations/configure`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
              toolkit: args.toolkit,
              scopes: args.scopes,
              displayName: args.display_name,
              oauth_credentials: args.oauth_credentials,
            }),
          });
          const data = await res.json();
          return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], ...(res.ok ? {} : { isError: true }) };
        }

        case 'rotate_credentials': {
          const tErr = need(args.toolkit, '"toolkit" is required for the "rotate_credentials" action.');
          if (tErr) return tErr;
          const cErr = need(args.oauth_credentials, '"oauth_credentials" is required for the "rotate_credentials" action.');
          if (cErr) return cErr;
          const res = await fetch(`${getBaseUrl()}/v1/${app_id}/integrations/configure/${encodeURIComponent(args.toolkit!)}/credentials`, {
            method: 'PATCH',
            headers: getHeaders(),
            body: JSON.stringify(args.oauth_credentials),
          });
          const data = await res.json();
          return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], ...(res.ok ? {} : { isError: true }) };
        }

        case 'disable': {
          const err = need(args.toolkit, '"toolkit" is required for the "disable" action.');
          if (err) return err;
          await apiDelete(`/v1/${app_id}/integrations/configure/${args.toolkit}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Integration disabled', toolkit: args.toolkit }, null, 2) }] };
        }

        case 'list_available': {
          const query = args.search ? `?search=${encodeURIComponent(args.search)}&curated=false` : '';
          const result = await apiGet(`/v1/${app_id}/integrations/available${query}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        case 'list_connected': {
          const result = await apiGet(`/v1/${app_id}/integrations/connections`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        case 'list_tools': {
          const query = args.toolkit ? `?toolkit=${encodeURIComponent(args.toolkit)}` : '';
          const result = await apiGet(`/v1/${app_id}/integrations/tools${query}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        case 'execute_action': {
          const err = need(args.tool_name, '"tool_name" is required for the "execute_action" action.');
          if (err) return err;
          const res = await fetch(`${getBaseUrl()}/v1/${app_id}/integrations/execute`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ toolName: args.tool_name, params: args.params || {}, userId: args.user_id }),
          });
          const data = await res.json();
          return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], ...(res.ok ? {} : { isError: true }) };
        }
      }
    }
  );
}
