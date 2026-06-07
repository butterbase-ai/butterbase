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

export function registerAgentTools(server: McpServer) {
  // --- list_agents -----------------------------------------------------------
  server.tool(
    'list_agents',
    `List all agents defined for a Butterbase app.

Returns: Array of agents with id, name, display_name, description, status, visibility, and timestamps.

Common errors:
  - 404: App not found
  - 403: Not authorized to access this app`,
    {
      app_id: z.string().describe('The app ID (e.g. app_abc123)'),
    },
    {
      title: 'List Agents',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async ({ app_id }) => {
      const result = await apiGet(`/v1/${app_id}/agents`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // --- get_agent -------------------------------------------------------------
  server.tool(
    'get_agent',
    `Get details for a single agent by name.

Returns: Full agent record including graph_spec, status, visibility, rate limits, and budget settings.

Common errors:
  - 404: Agent or app not found
  - 403: Not authorized`,
    {
      app_id: z.string().describe('The app ID'),
      name: z.string().describe('The agent name (slug, e.g. my-agent)'),
    },
    {
      title: 'Get Agent',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async ({ app_id, name }) => {
      const result = await apiGet(`/v1/${app_id}/agents/${name}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // --- create_agent ----------------------------------------------------------
  server.tool(
    'create_agent',
    `Create a new agent for a Butterbase app.

The graph_spec defines the agent's execution graph (nodes, edges, tools, limits).
spec_version must be "1".

Returns: The created agent record (HTTP 201).

Common errors:
  - 400: Invalid body or unsafe public agent with write tools (pass safety_acknowledged=true to override)
  - 409: Agent name already exists`,
    {
      app_id: z.string().describe('The app ID'),
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
        .describe('Agent slug — lowercase alphanumeric, hyphens, underscores'),
      graph_spec: graphSpecSchema.describe('The agent graph specification object'),
      display_name: z.string().optional().describe('Human-readable name'),
      description: z.string().optional().describe('What this agent does'),
      default_model: z
        .string()
        .optional()
        .describe('Default LLM model identifier (e.g. claude-3-5-haiku-20241022)'),
      ...agentAccessFields,
    },
    {
      title: 'Create Agent',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ app_id, ...body }) => {
      const result = await apiPost(`/v1/${app_id}/agents`, body);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // --- update_agent ----------------------------------------------------------
  server.tool(
    'update_agent',
    `Update an existing agent (partial patch — only supplied fields are changed).

Patchable fields: display_name, description, graph_spec, default_model, status,
visibility, max_runs_*, daily_budget_usd, max_concurrent_runs, safety_acknowledged.

Returns: Updated agent record.

Common errors:
  - 400: Invalid body or unsafe public agent
  - 404: Agent not found`,
    {
      app_id: z.string().describe('The app ID'),
      name: z.string().describe('The agent name to update'),
      display_name: z.string().optional().describe('Human-readable name'),
      description: z.string().optional().describe('What this agent does'),
      graph_spec: graphSpecSchema.optional().describe('Replacement graph spec'),
      default_model: z.string().optional().describe('Default LLM model identifier'),
      status: z
        .enum(['active', 'disabled'])
        .optional()
        .describe('Set to "disabled" to stop the agent accepting new runs'),
      ...agentAccessFields,
    },
    {
      title: 'Update Agent',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ app_id, name, ...body }) => {
      const result = await apiPatch(`/v1/${app_id}/agents/${name}`, body);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // --- delete_agent ----------------------------------------------------------
  server.tool(
    'delete_agent',
    `Permanently delete an agent and all associated runs.

Returns: Success message (the API responds 204 No Content on success).

Common errors:
  - 404: Agent not found`,
    {
      app_id: z.string().describe('The app ID'),
      name: z.string().describe('The agent name to delete'),
    },
    {
      title: 'Delete Agent',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ app_id, name }) => {
      await apiDelete(`/v1/${app_id}/agents/${name}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, message: `Agent '${name}' deleted.` }, null, 2),
          },
        ],
      };
    },
  );

  // --- validate_agent_spec ---------------------------------------------------
  // Uses the dedicated POST /v1/:appId/agents/:name/validate endpoint.
  // Requires app_id because the route is app-scoped (ownership check).
  // We pass a placeholder name "~validate" since the route only uses appId for auth.
  // The endpoint is stateless — it does not create or read any agent by that name.
  server.tool(
    'validate_agent_spec',
    `Validate an agent graph_spec without creating an agent.

Checks the spec against the schema (nodes, edges, tools, limits, spec_version).
Returns { valid: true } on success or { valid: false, issues: [...] } with Zod issue details.

Requires app_id for authentication — no agent is created or modified.`,
    {
      app_id: z.string().describe('Any app ID you own (used only for authentication)'),
      // Accept any object so the handler can return structured Zod validation errors
      // rather than the MCP layer rejecting the call before the handler runs.
      graph_spec: z.record(z.string(), z.unknown()).describe('The graph spec object to validate'),
    },
    {
      title: 'Validate Agent Spec',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ app_id, graph_spec }) => {
      // Client-side fast path — catch schema errors without a network round-trip.
      const parsed = graphSpecSchema.safeParse(graph_spec);
      if (!parsed.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ valid: false, issues: parsed.error.issues }, null, 2),
            },
          ],
        };
      }
      // Server-side confirmation via the dedicated validate endpoint.
      // The route is /v1/:appId/agents/:name/validate — :name is unused by the handler;
      // we pass a placeholder so the URL resolves correctly.
      try {
        const result = await apiPost(`/v1/${app_id}/agents/_/validate`, {
          graph_spec,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch {
        // If the server call fails (e.g. no network in test env), the client-side
        // parse already passed, so report valid.
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                valid: true,
                note: 'Client-side validation passed; server confirmation unavailable.',
              }, null, 2),
            },
          ],
        };
      }
    },
  );
}
