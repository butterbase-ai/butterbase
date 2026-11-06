import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

interface RegisteredTool {
  inputSchema?: z.ZodTypeAny;
  enabled: boolean;
  title?: string;
  annotations?: { title?: string };
}

/** All access to the SDK's private tool map lives here; contract-tested on the installed SDK. */
export function readRegisteredTools(server: McpServer): Record<string, RegisteredTool> | undefined {
  const tools = (server as unknown as { _registeredTools?: unknown })._registeredTools;
  return tools && typeof tools === 'object' && !Array.isArray(tools)
    ? tools as Record<string, RegisteredTool>
    : undefined;
}

export function finalizeRegisteredTools(server: McpServer): void {
  const tools = readRegisteredTools(server);
  if (!tools) throw new Error('MCP SDK tool registry unavailable');
  for (const tool of Object.values(tools)) {
    if (tool.annotations?.title && !tool.title) tool.title = tool.annotations.title;
    const schema = tool.inputSchema as z.ZodObject<z.ZodRawShape> | undefined;
    if (schema && typeof schema.strict === 'function' && schema.shape) {
      tool.inputSchema = schema.strict();
    } else if (schema?.shape && Object.keys(schema.shape).length === 0) {
      // Current SDK wraps an empty raw shape in Zod Mini, which has no strict().
      // An equivalent strict empty object keeps execution and validation aligned.
      tool.inputSchema = z.object({}).strict();
    }
  }
}
