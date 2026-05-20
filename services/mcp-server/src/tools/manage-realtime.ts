import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost } from '../api-client.js';

export function registerManageRealtime(server: McpServer) {
  server.tool(
    'manage_realtime',
    `Manage realtime WebSocket notifications for database tables.

Actions:
  - "configure": Enable realtime broadcasts (INSERT/UPDATE/DELETE) on the given tables.
                 Idempotent — already-enabled tables are skipped.
  - "get":       Return current realtime config (which tables, active LISTEN connection, websocket URL).

Parameters by action:
  configure: { app_id, action: "configure", tables: [...] }
  get:       { app_id, action: "get" }

After configuring, clients connect via WebSocket:
  ws://api.butterbase.local/v1/{app_id}/realtime
  Client sends:  { "type": "subscribe", "table": "messages" }
  Server sends:  { "type": "change", "table": "messages", "op": "INSERT", "record": {...} }

RLS enforcement:
  - End-user JWT connections only receive changes they have permission to see
  - API key / service connections receive all changes (RLS bypassed)
  - Anonymous connections use butterbase_anon role policies

Prerequisites:
  - Tables must already exist (use manage_schema action: "apply" first)
  - For user-scoped data, enable RLS on the table first (manage_rls action: "enable" / "create_user_isolation")`,
    {
      app_id: z.string().describe('The app ID'),
      action: z.enum(['configure', 'get']).describe('The action to perform'),
      tables: z.array(z.string()).optional().describe('Required for configure. Table names to enable realtime on.'),
    },
    {
      title: 'Manage Realtime',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const { app_id, action } = args;
      switch (action) {
        case 'configure': {
          if (!args.tables) {
            return {
              content: [{ type: 'text' as const, text: 'Error: "tables" is required for the "configure" action.' }],
              isError: true,
            };
          }
          const result = await apiPost(`/v1/${app_id}/realtime/configure`, { tables: args.tables });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'get': {
          const result = await apiGet(`/v1/${app_id}/realtime/config`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
      }
    }
  );
}
