import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost, apiPatch, apiDelete } from '../api-client.js';

// ---------------------------------------------------------------------------
// Graph spec schema — duplicated from control-api/src/services/agents-service.ts
// so the MCP server can validate specs client-side without a cross-package dep.
// Keep in sync with that file when making breaking spec changes.
// ---------------------------------------------------------------------------
const modeOverride = z.enum(['read_only', 'read_write']);
const exposedOverride = z.enum(['developer_only', 'end_user']);

const toolRefBuiltin = z.object({
  source: z.literal('builtin'),
  name: z.string().min(1),
  mode_override: modeOverride.optional(),
  exposed_to_override: exposedOverride.optional(),
});
const toolRefMcp = z.object({
  source: z.literal('mcp'),
  server_id: z.string().uuid(),
  name: z.string().min(1),
  mode_override: modeOverride.optional(),
  exposed_to_override: exposedOverride.optional(),
});
const toolRefFunction = z.object({
  source: z.literal('function'),
  name: z.string().min(1),
  mode_override: modeOverride.optional(),
  exposed_to_override: exposedOverride.optional(),
});
const toolRefSchema = z.discriminatedUnion('source', [
  toolRefBuiltin, toolRefMcp, toolRefFunction,
]);

const llmNodeSchema = z.object({
  type: z.literal('llm'),
  model: z.string().min(1),
  system_prompt: z.string(),
  input_template: z.string(),
  output_key: z.string().min(1),
  tools: z.array(toolRefSchema).default([]),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
});
const toolNodeSchema = z.object({
  type: z.literal('tool'),
  tool_ref: toolRefSchema,
  args_template: z.record(z.string(), z.unknown()),
  output_key: z.string().min(1),
});
const endNodeSchema = z.object({
  type: z.literal('end'),
  output_template: z.string(),
});
const nodeSchema = z.discriminatedUnion('type', [
  llmNodeSchema, toolNodeSchema, endNodeSchema,
]);

const toolRefOverride = z.object({
  mode_override: modeOverride.optional(),
  exposed_to_override: exposedOverride.optional(),
}).strict();

const mcpServerEntrySchema = z.object({
  server_id: z.string().uuid(),
  tools: z.array(z.string()),
  tool_overrides: z.record(z.string(), toolRefOverride).default({}),
});

const graphSpecSchema = z
  .object({
    spec_version: z.literal('1'),
    entry: z.string().min(1),
    nodes: z.record(z.string(), nodeSchema),
    edges: z.array(z.object({ from: z.string(), to: z.string() })),
    tools: z.object({
      builtin: z.array(z.string()),
      mcp_servers: z.array(mcpServerEntrySchema),
      functions: z.array(z.string()),
    }),
    limits: z.object({
      max_steps: z.number().int().min(1).max(200),
      max_tool_calls: z.number().int().min(0).max(500),
      max_parallel_tools: z.number().int().min(1).max(16),
      timeout_seconds: z.number().int().min(5).max(3600),
      human_timeout_seconds: z.number().int().min(60).max(7 * 24 * 3600),
    }),
  })
  .superRefine((spec, ctx) => {
    if (!spec.nodes[spec.entry]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `entry node '${spec.entry}' not in nodes`,
      });
    }
    for (const e of spec.edges) {
      if (!spec.nodes[e.from]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `edge from unknown node '${e.from}'`,
        });
      }
      if (!spec.nodes[e.to]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `edge to unknown node '${e.to}'`,
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// Shared access-control fields for create/update
// ---------------------------------------------------------------------------
const agentAccessFields = {
  visibility: z
    .enum(['private', 'authenticated', 'public'])
    .optional()
    .describe('Who can invoke the agent'),
  max_runs_per_user_per_hour: z
    .number().int().positive()
    .optional()
    .describe('Rate limit per authenticated user per hour (null = unlimited)'),
  max_runs_per_ip_per_hour: z
    .number().int().positive()
    .optional()
    .describe('Rate limit per IP address per hour (null = unlimited)'),
  max_runs_per_app_per_hour: z
    .number().int().positive()
    .optional()
    .describe('Rate limit across the whole app per hour (null = unlimited)'),
  daily_budget_usd: z
    .number().positive()
    .optional()
    .describe('Daily spend cap in USD (null = unlimited)'),
  max_concurrent_runs: z
    .number().int().positive()
    .optional()
    .describe('Maximum simultaneous active runs (null = unlimited)'),
  safety_acknowledged: z
    .boolean()
    .optional()
    .describe('Set true to confirm you accept the risks of public write-capable agents'),
};

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerManageAgents(server: McpServer) {
  server.tool(
    'manage_agents',
    `Manage agents for a Butterbase app: list, get, create, update, delete, and validate specs.

Actions:
  - "list":     List all agents defined for an app.
  - "get":      Get a single agent by name (full record incl. graph_spec).
  - "create":   Create a new agent. Requires name + graph_spec.
  - "update":   Patch an existing agent (partial update). Requires name.
  - "delete":   Permanently delete an agent and all its runs. Requires name.
  - "validate": Validate a graph_spec without creating an agent. Requires graph_spec.

Parameters by action:
  list:     { action: "list", app_id }
  get:      { action: "get", app_id, name }
  create:   { action: "create", app_id, name, graph_spec, display_name?, description?, default_model?, ...access_fields? }
  update:   { action: "update", app_id, name, display_name?, description?, graph_spec?, default_model?, status?, ...access_fields? }
  delete:   { action: "delete", app_id, name }
  validate: { action: "validate", app_id, graph_spec }

Common errors:
  - 404: Agent or app not found
  - 403: Not authorized
  - 409: Agent name already exists (on create)
  - 400: Invalid body or unsafe public agent (pass safety_acknowledged=true to override)`,
    {
      action: z
        .enum(['list', 'get', 'create', 'update', 'delete', 'validate'])
        .describe('The action to perform'),
      app_id: z.string().describe('The app ID (e.g. app_abc123)'),
      name: z
        .string()
        .optional()
        .describe('Agent slug. Required for get/update/delete; required for create (must match /^[a-z0-9][a-z0-9_-]{0,63}$/)'),
      graph_spec: z
        .unknown()
        .optional()
        .describe('Graph spec object. Required for create and validate; optional for update. Validated by graphSpecSchema except on validate (which returns structured issues instead of rejecting).'),
      display_name: z.string().optional().describe('Human-readable name. Optional for create/update.'),
      description: z.string().optional().describe('What this agent does. Optional for create/update.'),
      default_model: z.string().optional().describe('Default LLM model identifier. Optional for create/update.'),
      status: z
        .enum(['active', 'disabled'])
        .optional()
        .describe('Optional for update. Set to "disabled" to stop the agent accepting new runs.'),
      ...agentAccessFields,
    },
    {
      title: 'Manage Agents',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const { action, app_id } = args;
      const need = (cond: unknown, msg: string) =>
        cond
          ? null
          : { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };

      switch (action) {
        case 'list': {
          const result = await apiGet(`/v1/${app_id}/agents`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'get': {
          const err = need(args.name, '"name" is required for the "get" action.');
          if (err) return err;
          const result = await apiGet(`/v1/${app_id}/agents/${args.name}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'create': {
          const err =
            need(args.name, '"name" is required for the "create" action.') ??
            need(args.graph_spec, '"graph_spec" is required for the "create" action.');
          if (err) return err;
          const nameOk = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(args.name!);
          const err2 = need(nameOk, '"name" must match /^[a-z0-9][a-z0-9_-]{0,63}$/');
          if (err2) return err2;
          const specParsed = graphSpecSchema.safeParse(args.graph_spec);
          if (!specParsed.success) {
            return {
              content: [{ type: 'text' as const, text: `Error: invalid graph_spec — ${JSON.stringify(specParsed.error.issues)}` }],
              isError: true as const,
            };
          }
          const body: Record<string, unknown> = {
            name: args.name,
            graph_spec: specParsed.data,
          };
          for (const k of ['display_name', 'description', 'default_model', 'visibility',
            'max_runs_per_user_per_hour', 'max_runs_per_ip_per_hour', 'max_runs_per_app_per_hour',
            'daily_budget_usd', 'max_concurrent_runs', 'safety_acknowledged'] as const) {
            if (args[k] !== undefined) body[k] = args[k];
          }
          const result = await apiPost(`/v1/${app_id}/agents`, body);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'update': {
          const err = need(args.name, '"name" is required for the "update" action.');
          if (err) return err;
          const body: Record<string, unknown> = {};
          for (const k of ['display_name', 'description', 'default_model', 'status', 'visibility',
            'max_runs_per_user_per_hour', 'max_runs_per_ip_per_hour', 'max_runs_per_app_per_hour',
            'daily_budget_usd', 'max_concurrent_runs', 'safety_acknowledged'] as const) {
            if (args[k] !== undefined) body[k] = args[k];
          }
          if (args.graph_spec !== undefined) {
            const specParsed = graphSpecSchema.safeParse(args.graph_spec);
            if (!specParsed.success) {
              return {
                content: [{ type: 'text' as const, text: `Error: invalid graph_spec — ${JSON.stringify(specParsed.error.issues)}` }],
                isError: true as const,
              };
            }
            body.graph_spec = specParsed.data;
          }
          const result = await apiPatch(`/v1/${app_id}/agents/${args.name}`, body);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'delete': {
          const err = need(args.name, '"name" is required for the "delete" action.');
          if (err) return err;
          await apiDelete(`/v1/${app_id}/agents/${args.name}`);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: true, message: `Agent '${args.name}' deleted.` }, null, 2) }],
          };
        }
        case 'validate': {
          const err = need(args.graph_spec, '"graph_spec" is required for the "validate" action.');
          if (err) return err;
          const parsed = graphSpecSchema.safeParse(args.graph_spec);
          if (!parsed.success) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ valid: false, issues: parsed.error.issues }, null, 2) }],
            };
          }
          try {
            const result = await apiPost(`/v1/${app_id}/agents/_/validate`, { graph_spec: args.graph_spec });
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
          } catch {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ valid: true, note: 'Client-side validation passed; server confirmation unavailable.' }, null, 2) }],
            };
          }
        }
      }
    },
  );
}
