import type { Pool } from 'pg';
import { z } from 'zod';

const modeOverride = z.enum(['read_only', 'read_write']);
const exposedOverride = z.enum(['developer_only', 'end_user']);

const toolRefOverride = z.object({
  mode_override: modeOverride.optional(),
  exposed_to_override: exposedOverride.optional(),
}).strict();

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

const mcpServerEntrySchema = z.object({
  server_id: z.string().uuid(),
  tools: z.array(z.string()),
  tool_overrides: z.record(z.string(), toolRefOverride).default({}),
});

export const graphSpecSchema = z
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

export type GraphSpec = z.infer<typeof graphSpecSchema>;

export type AgentVisibility = 'private' | 'authenticated' | 'public';

export const agentAccessPatchSchema = z.object({
  visibility: z.enum(['private', 'authenticated', 'public']).optional(),
  max_runs_per_user_per_hour: z.number().int().positive().nullable().optional(),
  max_runs_per_ip_per_hour: z.number().int().positive().nullable().optional(),
  max_runs_per_app_per_hour: z.number().int().positive().nullable().optional(),
  daily_budget_usd: z.number().positive().nullable().optional(),
  max_concurrent_runs: z.number().int().positive().nullable().optional(),
  safety_acknowledged: z.boolean().optional(),
});

export type AgentAccessPatch = z.infer<typeof agentAccessPatchSchema>;

export interface AgentRow {
  id: string;
  app_id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  graph_spec: GraphSpec;
  default_model: string | null;
  status: string;
  visibility: AgentVisibility;
  max_runs_per_user_per_hour: number | null;
  max_runs_per_ip_per_hour: number | null;
  max_runs_per_app_per_hour: number | null;
  daily_budget_usd: string | null;
  max_concurrent_runs: number | null;
  safety_acknowledged: boolean;
  created_at: string;
  updated_at: string;
}

export async function createAgent(
  db: Pool,
  appId: string,
  input: {
    name: string;
    display_name?: string;
    description?: string;
    graph_spec: GraphSpec;
    default_model?: string;
  } & AgentAccessPatch,
): Promise<AgentRow> {
  const result = await db.query(
    `INSERT INTO agents
       (app_id, name, display_name, description, graph_spec, default_model,
        visibility, max_runs_per_user_per_hour, max_runs_per_ip_per_hour,
        max_runs_per_app_per_hour, daily_budget_usd, max_concurrent_runs,
        safety_acknowledged)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6,
             COALESCE($7, 'private'), $8, $9, $10, $11, $12, COALESCE($13, false))
     RETURNING id, app_id, name, display_name, description, graph_spec,
               default_model, status, visibility,
               max_runs_per_user_per_hour, max_runs_per_ip_per_hour, max_runs_per_app_per_hour,
               daily_budget_usd, max_concurrent_runs, safety_acknowledged,
               created_at, updated_at`,
    [
      appId, input.name, input.display_name ?? null, input.description ?? null,
      JSON.stringify(input.graph_spec), input.default_model ?? null,
      input.visibility ?? null,
      input.max_runs_per_user_per_hour ?? null,
      input.max_runs_per_ip_per_hour ?? null,
      input.max_runs_per_app_per_hour ?? null,
      input.daily_budget_usd ?? null,
      input.max_concurrent_runs ?? null,
      input.safety_acknowledged ?? null,
    ],
  );
  return result.rows[0];
}

export async function listAgents(db: Pool, appId: string): Promise<AgentRow[]> {
  const result = await db.query(
    `SELECT id, app_id, name, display_name, description, graph_spec,
            default_model, status, visibility,
            max_runs_per_user_per_hour, max_runs_per_ip_per_hour, max_runs_per_app_per_hour,
            daily_budget_usd, max_concurrent_runs, safety_acknowledged,
            created_at, updated_at
     FROM agents
     WHERE app_id = $1
     ORDER BY created_at DESC`,
    [appId],
  );
  return result.rows;
}

export async function getAgent(
  db: Pool,
  appId: string,
  name: string,
): Promise<AgentRow | null> {
  const result = await db.query(
    `SELECT id, app_id, name, display_name, description, graph_spec,
            default_model, status, visibility,
            max_runs_per_user_per_hour, max_runs_per_ip_per_hour, max_runs_per_app_per_hour,
            daily_budget_usd, max_concurrent_runs, safety_acknowledged,
            created_at, updated_at
     FROM agents
     WHERE app_id = $1 AND name = $2`,
    [appId, name],
  );
  return result.rows[0] ?? null;
}

export async function updateAgent(
  db: Pool,
  appId: string,
  name: string,
  patch: Partial<{
    display_name: string;
    description: string;
    graph_spec: GraphSpec;
    default_model: string;
    status: 'active' | 'disabled';
  }> & AgentAccessPatch,
): Promise<AgentRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [appId, name];
  let i = 3;
  if (patch.display_name !== undefined) { sets.push(`display_name = $${i++}`); values.push(patch.display_name); }
  if (patch.description !== undefined) { sets.push(`description = $${i++}`); values.push(patch.description); }
  if (patch.graph_spec !== undefined) { sets.push(`graph_spec = $${i++}::jsonb`); values.push(JSON.stringify(patch.graph_spec)); }
  if (patch.default_model !== undefined) { sets.push(`default_model = $${i++}`); values.push(patch.default_model); }
  if (patch.status !== undefined) { sets.push(`status = $${i++}`); values.push(patch.status); }
  if (patch.visibility !== undefined) { sets.push(`visibility = $${i++}`); values.push(patch.visibility); }
  if (patch.max_runs_per_user_per_hour !== undefined) { sets.push(`max_runs_per_user_per_hour = $${i++}`); values.push(patch.max_runs_per_user_per_hour); }
  if (patch.max_runs_per_ip_per_hour !== undefined) { sets.push(`max_runs_per_ip_per_hour = $${i++}`); values.push(patch.max_runs_per_ip_per_hour); }
  if (patch.max_runs_per_app_per_hour !== undefined) { sets.push(`max_runs_per_app_per_hour = $${i++}`); values.push(patch.max_runs_per_app_per_hour); }
  if (patch.daily_budget_usd !== undefined) { sets.push(`daily_budget_usd = $${i++}`); values.push(patch.daily_budget_usd); }
  if (patch.max_concurrent_runs !== undefined) { sets.push(`max_concurrent_runs = $${i++}`); values.push(patch.max_concurrent_runs); }
  if (patch.safety_acknowledged !== undefined) { sets.push(`safety_acknowledged = $${i++}`); values.push(patch.safety_acknowledged); }
  if (sets.length === 0) {
    return getAgent(db, appId, name);
  }
  sets.push(`updated_at = now()`);
  const result = await db.query(
    `UPDATE agents SET ${sets.join(', ')}
     WHERE app_id = $1 AND name = $2
     RETURNING id, app_id, name, display_name, description, graph_spec,
               default_model, status, visibility,
               max_runs_per_user_per_hour, max_runs_per_ip_per_hour, max_runs_per_app_per_hour,
               daily_budget_usd, max_concurrent_runs, safety_acknowledged,
               created_at, updated_at`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function deleteAgent(
  db: Pool,
  appId: string,
  name: string,
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM agents WHERE app_id = $1 AND name = $2`,
    [appId, name],
  );
  return (result.rowCount ?? 0) > 0;
}
