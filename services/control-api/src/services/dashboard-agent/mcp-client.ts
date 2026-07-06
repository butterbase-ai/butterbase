/**
 * MCP client wrapper for the dashboard assistant.
 * Calls the MCP server's HTTP endpoint with proper auth context.
 */

import { getToolCatalog } from './tool-catalog.js';

export { getToolCatalog };
export type { ToolSpec } from './tool-catalog.js';

export type McpCallResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

/**
 * Call an MCP tool via the HTTP endpoint.
 * @param name - The MCP tool name (e.g., 'manage_app')
 * @param args - Tool arguments as an object
 * @param jwt - Cognito Bearer JWT token
 * @returns Result object with ok flag, result, or error
 */
export async function callMcpTool(
  name: string,
  args: unknown,
  jwt: string,
): Promise<McpCallResult> {
  const url = `${process.env.MCP_SERVER_URL ?? 'http://localhost:3010'}/mcp`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });

    if (!res.ok) {
      return { ok: false, error: `mcp ${res.status}` };
    }

    const body = await res.json() as { result?: unknown; error?: { message?: string } };

    if (body.error) {
      return { ok: false, error: String(body.error.message ?? body.error) };
    }

    return { ok: true, result: body.result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
