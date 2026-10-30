import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRegisteredToolServer } from '@butterbase/mcp-server/tool-registry';
import { createRegisteredToolValidator, validateRegisteredToolArguments } from '@butterbase/mcp-server/tool-validation';

const Id = z.string().trim().min(1).max(128);
const App = { app_id: Id };
export const WorkspaceFunctionSchema = z.object({
  ...App,
  function_name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  trigger: z.object({ type: z.enum(['http', 'cron', 's3_upload', 'webhook', 'websocket']), config: z.unknown().optional() }).strict().optional(),
  envVars: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  memoryLimitMb: z.number().int().positive().optional(),
}).strict();

/** Execution contracts for loop-local names. Never send one of these to MCP. */
export const LocalOperationSchemas: Record<string, z.ZodTypeAny> = {
  deploy_frontend: z.object(App).strict(),
  deploy_function_from_workspace: WorkspaceFunctionSchema,
  write_file: z.object({ ...App, path: z.string().min(1), content: z.string() }).strict(),
  read_file: z.object({ ...App, path: z.string().min(1) }).strict(),
  list_files: z.object(App).strict(),
  delete_file: z.object({ ...App, path: z.string().min(1) }).strict(),
  update_operator_scratchpad: z.object({ content: z.string().max(8000) }).strict(),
  run_sandbox_code: z.object({ code: z.string().min(1) }).strict(),
  build_app: z.object(App).strict(),
  list_pending_decisions: z.object({}).strict(),
  skill_creator: z.object({ request: z.string().trim().min(1), target_skill_id: Id.optional(), draft_version_id: Id.optional(), timezone: z.string().optional() }).strict(),
  run_skill_script: z.object({ entrypoint: z.string().optional(), input: z.unknown().optional() }).strict(),
};

export type ValidatedOperation = { toolName: string; args: Record<string, unknown> };
export type ProposalToolValidator = (name: string, args: unknown) => Promise<ValidatedOperation>;
let proposalToolValidator: ProposalToolValidator | null = null;
export function setProposalToolValidator(validator: ProposalToolValidator | null): void { proposalToolValidator = validator; }
export function validateProposalToolArguments(name: string, args: unknown): Promise<ValidatedOperation> {
  return (proposalToolValidator ?? validateRegisteredToolArguments)(name, args);
}
/** Cloud bootstrap supplies the exact overlay registrations explicitly. This
 * also works in source checkouts without the production bundled directory. */
export async function createProposalToolValidator(registerOverlays: (server: McpServer) => void | Promise<void>): Promise<ProposalToolValidator> {
  const validator = createRegisteredToolValidator(await createRegisteredToolServer({ registerOverlays }));
  return (name, args) => validator.validate(name, args);
}
export class ProposalValidationError extends Error {
  constructor(readonly code: 'tool_unavailable' | 'tool_arguments_invalid' | 'proposal_invalid') { super(code); }
}

export function validateLocalOperation(name: string, args: unknown, availableExecutors: ReadonlySet<string>): ValidatedOperation | null {
  const schema = LocalOperationSchemas[name];
  if (!schema) return null;
  if (!availableExecutors.has(name)) throw new ProposalValidationError('tool_unavailable');
  const result = schema.safeParse(args);
  if (!result.success) throw new ProposalValidationError('tool_arguments_invalid');
  return { toolName: name, args: result.data };
}

export async function validateProposalOperation(name: string, args: unknown, context: {
  effectiveToolNames: ReadonlySet<string>;
  availableExecutors: ReadonlySet<string>;
  validateRegistered(name: string, args: unknown): Promise<ValidatedOperation>;
}): Promise<ValidatedOperation> {
  if (!context.effectiveToolNames.has(name)) throw new ProposalValidationError('tool_unavailable');
  if (name === 'propose_action' || (name === 'manage_substrate' && ['approve', 'reject', 'resolve_policy_conflict'].includes(String((args as any)?.action)))) {
    throw new ProposalValidationError('proposal_invalid');
  }
  return validateLocalOperation(name, args, context.availableExecutors) ?? await context.validateRegistered(name, args);
}
