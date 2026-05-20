// services/mcp-server/src/tools/integrations.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiDelete, getBaseUrl, getHeaders } from '../api-client.js';

export function registerIntegrations(server: McpServer) {
  server.tool(
    'manage_integrations',
    `Manage third-party integrations for a Butterbase app (e.g., Gmail, Slack, Google Calendar).

Actions:
  - "configure":      Enable or manage a third-party integration toolkit for an app
  - "disable":        Disable a configured integration toolkit
  - "list_available": List available integrations that can be enabled (curated or full catalog)
  - "list_connected": List connected integration accounts for an app
  - "list_tools":     List available tool actions for connected integrations
  - "execute_action": Execute a tool action on a connected integration (e.g., send email, create event)

Parameters by action:
  configure:      { app_id, action: "configure", toolkit, scopes?, display_name? }
  disable:        { app_id, action: "disable", toolkit }
  list_available: { app_id, action: "list_available", search? }
  list_connected: { app_id, action: "list_connected" }
  list_tools:     { app_id, action: "list_tools", toolkit? }
  execute_action: { app_id, action: "execute_action", tool_name, params?, user_id? }

Curated toolkits (first-class support):
  gmail, google-calendar, slack, google-sheets, notion, github, hubspot, outlook, google-drive, discord

Example — configure:
  Input:  { app_id: "app_abc123", action: "configure", toolkit: "gmail", scopes: ["gmail.send"] }
  Output: { id: "...", toolkit_slug: "gmail", enabled: true }

Example — list_available:
  Input:  { app_id: "app_abc123", action: "list_available" }
  Output: { integrations: [{ toolkit: "gmail", displayName: "Gmail", curated: true }, ...] }

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
  - INTEGRATIONS_NOT_CONNECTED: User hasn't connected this integration
  - INTEGRATIONS_EXECUTION_FAILED: Integration tool execution failed
  - RESOURCE_NOT_FOUND: App doesn't exist`,
    {
      action: z.enum(['configure', 'disable', 'list_available', 'list_connected', 'list_tools', 'execute_action'])
        .describe('The action to perform'),
      app_id: z.string().describe('The app ID (e.g. app_abc123def456)'),
      // configure / disable params
      toolkit: z.string().optional().describe('Integration toolkit slug (e.g. gmail, slack). Required for configure and disable.'),
      scopes: z.array(z.string()).optional().describe('OAuth scopes to request (configure only)'),
      display_name: z.string().optional().describe('Custom display name (configure only)'),
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
            body: JSON.stringify({ toolkit: args.toolkit, scopes: args.scopes, displayName: args.display_name }),
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
