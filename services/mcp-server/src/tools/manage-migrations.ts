import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost } from '../api-client.js';

export function registerManageMigrations(server: McpServer) {
  server.tool(
    'manage_migrations',
    `Read and control in-flight app migrations.

This complements manage_app (actions: move / move_status / teardown_source_replica) with the four
operational routes those actions don't cover.

Actions:
  - get_active             : { app_id, action: "get_active" }
                             Returns the running migration for this app, or { migration: null }.
  - abort                  : { app_id, migration_id, action: "abort" }
                             Cancel a migration that has NOT yet reached "flipping_routing".
                             Returns 409 if already past cutover; use "reverse" instead.
  - reverse                : { app_id, migration_id, action: "reverse" }
                             Roll a COMPLETED migration back to source. Only works while the
                             source replica is still retained (see list_source_replicas).
  - list_source_replicas   : { action: "list_source_replicas" }
                             Lists active retained source replicas for the caller's apps.
                             Use this before tearing down to discover what's still around.

Use list_regions + manage_app (action: "move") to start a move; manage_app (action: "move_status") to watch progress;
manage_app (action: "teardown_source_replica") when you're confident the move is stable.`,
    {
      app_id: z.string().optional().describe('Required for get_active / abort / reverse.'),
      migration_id: z.string().optional().describe('Required for abort / reverse.'),
      action: z.enum(['get_active', 'abort', 'reverse', 'list_source_replicas']).describe('The action to perform'),
    },
    {
      title: 'Manage Migrations',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      try {
        const { action } = args;
        let result: unknown;
        switch (action) {
          case 'get_active': {
            if (!args.app_id) {
              return { content: [{ type: 'text' as const, text: 'Error: "app_id" is required for "get_active".' }], isError: true as const };
            }
            result = await apiGet(`/v1/apps/${args.app_id}/migrations/active`);
            break;
          }
          case 'abort': {
            if (!args.app_id || !args.migration_id) {
              return { content: [{ type: 'text' as const, text: 'Error: "app_id" and "migration_id" are required for "abort".' }], isError: true as const };
            }
            result = await apiPost(`/v1/apps/${args.app_id}/migrations/${args.migration_id}/abort`, {});
            break;
          }
          case 'reverse': {
            if (!args.app_id || !args.migration_id) {
              return { content: [{ type: 'text' as const, text: 'Error: "app_id" and "migration_id" are required for "reverse".' }], isError: true as const };
            }
            result = await apiPost(`/v1/apps/${args.app_id}/migrations/${args.migration_id}/reverse`, {});
            break;
          }
          case 'list_source_replicas': {
            result = await apiGet(`/v1/source-replicas`);
            break;
          }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
      }
    },
  );
}
