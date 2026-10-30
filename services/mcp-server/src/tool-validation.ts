import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readRegisteredTools } from './sdk-tool-registry.js';
import { createRegisteredToolServer } from './tool-registry.js';

export interface RegisteredToolValidator {
  validate(name: string, args: unknown): Promise<{ toolName: string; args: Record<string, unknown> }>;
}

export type ToolValidationErrorCode = 'tool_registry_unavailable' | 'tool_unavailable' | 'tool_schema_unavailable' | 'tool_arguments_invalid';

const ERROR_MESSAGES: Record<ToolValidationErrorCode, string> = {
  tool_registry_unavailable: 'Tool registry is unavailable',
  tool_unavailable: 'Tool is unavailable',
  tool_schema_unavailable: 'Tool argument schema is unavailable',
  tool_arguments_invalid: 'Tool arguments are invalid',
};

/** Safe diagnostics deliberately omit tool arguments, parser issues and exception causes. */
export class ToolValidationError extends Error {
  constructor(public readonly code: ToolValidationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ToolValidationError';
  }
}

export function createRegisteredToolValidator(server: McpServer): RegisteredToolValidator {
  return {
    async validate(name, args) {
      const tools = readRegisteredTools(server);
      if (!tools) throw new ToolValidationError('tool_registry_unavailable');
      if (typeof name !== 'string' || !Object.hasOwn(tools, name) || tools[name]?.enabled !== true) {
        throw new ToolValidationError('tool_unavailable');
      }
      const schema = tools[name].inputSchema;
      if (!schema || typeof schema.safeParseAsync !== 'function') {
        throw new ToolValidationError('tool_schema_unavailable');
      }
      try {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new ToolValidationError('tool_arguments_invalid');
        }
        const parsed = await schema.safeParseAsync(args);
        if (!parsed.success || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
          throw new ToolValidationError('tool_arguments_invalid');
        }
        return { toolName: name, args: parsed.data as Record<string, unknown> };
      } catch {
        throw new ToolValidationError('tool_arguments_invalid');
      }
    },
  };
}

let singleton: Promise<RegisteredToolValidator> | undefined;

/** Cloud overlays are registered and finalized before this shared pure validator becomes visible. */
export function getRegisteredToolValidator(): Promise<RegisteredToolValidator> {
  singleton ??= createRegisteredToolServer().then(createRegisteredToolValidator).catch(() => {
    singleton = undefined;
    throw new ToolValidationError('tool_registry_unavailable');
  });
  return singleton;
}

export async function validateRegisteredToolArguments(name: string, args: unknown): Promise<{ toolName: string; args: Record<string, unknown> }> {
  return (await getRegisteredToolValidator()).validate(name, args);
}
