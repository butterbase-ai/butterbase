import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet } from '../api-client.js';

export function registerListRegions(server: McpServer) {
  server.tool(
    'list_regions',
    `List the regions an app can be created or moved to.

Returns the live set of supported regions. Use this before calling init_app or
manage_app (action: "move") to validate a region slug, or to present region choices to a user.

Returns: { regions: string[] }  e.g. { regions: ["us-east-1", "us-west-2"] }

Idempotency: Safe to call anytime (read-only operation).`,
    {},
    {
      title: 'List Regions',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async () => {
      try {
        const result = await apiGet('/v1/regions');
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
      }
    },
  );
}
