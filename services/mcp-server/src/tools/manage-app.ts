import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiDelete, apiPatch, apiPost } from '../api-client.js';

export function registerManageApp(server: McpServer) {
  server.tool(
    'manage_app',
    `Manage app lifecycle: list, delete, pause/resume, get config, update access mode, secure, and update CORS.

Actions:
  - "list":               List all backend apps with basic metadata (no app_id needed)
  - "delete":             Delete an app and ALL its resources permanently (IRREVERSIBLE)
  - "pause":              Pause or resume all data-plane traffic for an app (kill-switch)
  - "get_config":         Get detailed configuration for an app including CORS, storage settings, and metadata
  - "update_access_mode": Toggle an app's access mode between "public" and "authenticated"
  - "secure":             Lock down an app: sets access_mode to "authenticated" and optionally enables RLS user isolation
  - "update_cors":        Update CORS allowed origins to control which frontend domains can access your API

Parameters by action:
  list:               { action: "list" }
  delete:             { action: "delete", app_id }
  pause:              { action: "pause", app_id, paused, reason? }
  get_config:         { action: "get_config", app_id }
  update_access_mode: { action: "update_access_mode", app_id, access_mode }
  secure:             { action: "secure", app_id, tables? }
  update_cors:        { action: "update_cors", app_id, allowed_origins }

Common errors:
  - RESOURCE_NOT_FOUND: App doesn't exist, verify app_id with action: "list"
  - AUTH_INVALID_API_KEY: Check your API key is set correctly`,
    {
      action: z.enum(['list', 'delete', 'pause', 'get_config', 'update_access_mode', 'secure', 'update_cors'])
        .describe('The action to perform'),
      app_id: z.string().optional().describe('The app ID (e.g. app_abc123def456). Required for all actions except "list".'),
      // pause params
      paused: z.boolean().optional().describe('Required for "pause". true to pause; false to resume.'),
      reason: z.string().max(500).optional().describe('Optional for "pause". Human-readable reason; surfaced in 503 responses while paused.'),
      // update_access_mode params
      access_mode: z.enum(['public', 'authenticated']).optional().describe('Required for "update_access_mode". "public" allows anonymous access, "authenticated" requires end-user JWT or API key.'),
      // secure params
      tables: z.array(z.object({
        table_name: z.string().describe('Table name to enable user isolation on'),
        user_column: z.string().describe('Column storing the user ID (e.g. "user_id", "author_id")'),
        public_read_column: z.string().optional().describe('Optional boolean column (e.g. "is_published"). Creates SELECT policies so all users can read rows where this column is true.'),
      })).optional().describe('Optional for "secure". Tables to enable RLS user isolation on. Omit to only toggle access_mode.'),
      // update_cors params
      allowed_origins: z.array(z.string().url()).min(1).optional().describe('Required for "update_cors". Array of allowed origin URLs (e.g. ["http://localhost:3000", "https://myapp.com"])'),
    },
    {
      title: 'Manage App',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const { action } = args;
      const need = (cond: unknown, msg: string) =>
        cond ? null : { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };

      switch (action) {
        case 'list': {
          const result = await apiGet('/apps');
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'delete': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const result = await apiDelete(`/apps/${args.app_id}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'pause': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const err2 = need(args.paused !== undefined, '"paused" is required for the "pause" action.');
          if (err2) return err2;
          const result = await apiPatch(`/v1/${args.app_id}/config/pause`, { paused: args.paused, reason: args.reason });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'get_config': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const result = await apiGet(`/v1/${args.app_id}/config`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'update_access_mode': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const err2 = need(args.access_mode, '"access_mode" is required for the "update_access_mode" action.');
          if (err2) return err2;
          const result = await apiPatch(`/v1/${args.app_id}/config/access-mode`, { access_mode: args.access_mode });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'secure': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const result = await apiPost(`/v1/${args.app_id}/secure`, { tables: args.tables ?? [] });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'update_cors': {
          const err = need(args.app_id, '"app_id" is required for this action.');
          if (err) return err;
          const err2 = need(args.allowed_origins, '"allowed_origins" is required for the "update_cors" action.');
          if (err2) return err2;
          const result = await apiPatch(`/v1/${args.app_id}/config/cors`, { allowed_origins: args.allowed_origins });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
      }
    }
  );
}
