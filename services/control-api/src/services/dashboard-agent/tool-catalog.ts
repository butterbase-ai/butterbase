/**
 * Tool catalog for the dashboard assistant.
 * Exposes every MCP tool the mcp-server registers, with a flat/permissive
 * JSON-schema per tool. The MCP server enforces the real Zod schema at
 * dispatch time; we just need to let the LLM know each tool exists and
 * the shape it takes.
 *
 * Every tool listed here is also allowlisted for dispatch (see the loop's
 * tool-name guard).
 */

export type ToolSpec = {
  name: string;
  description: string;
  parameters: object; // JSON schema
  // Base sensitivity hint (Plan 3b). Currently INERT — `sensitivityFor` does
  // not read it (see the note at its 'safe' fallback, decided 2026-08-05).
  // Retained as documentation of intent and for a future revisit.
  sensitivity?: 'safe' | 'confirm' | 'destructive';
  /**
   * Operator-only tool: it exists for the headless operator and must NOT be
   * offered to the human assistant. The loop filters these out of the
   * non-operator catalog, so the assistant's tool list is unchanged by their
   * presence here.
   *
   * They live in this shared catalog rather than a second operator-specific
   * catalog on purpose: `operator-policy.ts` is the single allowlist, and a
   * test pins that every allowlisted tool is described here. A separate list
   * is exactly the drift that produced the empty-intersection bug.
   */
  operatorOnly?: true;
};

// Shared "flat, permissive" params shape: LLM passes `action` (when the tool
// has one) plus any additional tool-specific fields — mirroring the actual
// MCP tool Zod schemas which take flat args, not `{params: {...}}` wrappers.
function flatActionParams(): object {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action to perform (see description for allowed values).' },
    },
    required: ['action'],
    additionalProperties: true,
  };
}
function flatOpen(): object {
  return { type: 'object', properties: {}, additionalProperties: true };
}

/**
 * The operator's scratchpad-write tool.
 *
 * Dispatched IN-PROCESS by the loop (like the file-op and deploy primitives),
 * never forwarded to the MCP server — there is no such MCP tool. It writes the
 * control-plane row for the org derived from the operator's own sentinel
 * identity, so the target org is never taken from model-supplied arguments.
 */
export const OPERATOR_SCRATCHPAD_TOOL = 'update_operator_scratchpad';

/**
 * The operator's sandbox-code-execution tool.
 *
 * Dispatched IN-PROCESS by the loop, exactly like `OPERATOR_SCRATCHPAD_TOOL` —
 * there is no MCP tool by this name. Unlike the scratchpad, dispatch here is
 * conditional on a `codeExecutor` being present on the turn: `SandboxRunner`
 * supplies one (wired to a live, credential-less MicroVM); `LocalRunner` does
 * not, and there is deliberately NO host-execution fallback. When no
 * `codeExecutor` is present the loop drops this entry from the catalog it
 * offers the model (see `runAgentTurn`'s `tools` construction) — the tool must
 * be unreachable, not merely refused, on that path.
 */
export const OPERATOR_SANDBOX_CODE_TOOL = 'run_sandbox_code';

/**
 * The operator's BUILD tool — phase 3's one new model-facing capability.
 *
 * Dispatched IN-PROCESS, gated on a `buildExecutor` for the turn, exactly like
 * `OPERATOR_SANDBOX_CODE_TOOL` and for the identical reason: the build runs in
 * the MicroVM, there is no host-side fallback, and a turn with no sandbox must
 * find the tool ABSENT rather than merely refused.
 *
 * NOT a second flavour of `run_sandbox_code`, even though both end in the same
 * VM. `run_sandbox_code` runs a Python string the model wrote, and knows
 * nothing about the app. This one hydrates the app's ACTUAL working tree from
 * presigned blob urls, runs the SAME `npm install` + `npm run build` the
 * from-source deploy will run, and hands back the compiler's own diagnostics.
 * The model could in principle reconstruct that from `run_sandbox_code` — but
 * only by being handed the source, which is the one thing the credential rule
 * forbids putting in its hands as literal text on the way in.
 */
export const OPERATOR_BUILD_TOOL = 'build_app';

export function getToolCatalog(): ToolSpec[] {
  return [
    // ---- App lifecycle & discovery ----
    {
      name: 'manage_app',
      description:
        'Manage EXISTING app lifecycle. Actions: "list", "delete", "pause", "get_config", "set_visibility", "update_access_mode", "secure", "update_cors", "preview_clone_env_vars", "clone", "get_clone_job", "find_templates", "set_clone_webhook", "link_substrate", "unlink_substrate", "set_substrate_autopropagate", "move", "move_status", "teardown_source_replica", "get_env", "update_env". Call action="list" first in a new conversation.',
      parameters: flatActionParams(),
      sensitivity: 'confirm',
    },
    {
      name: 'init_app',
      description:
        'Create a NEW Butterbase app. Required: `name`, `region` (e.g. "us-east-1", "eu-west-1"). Returns the new app_id. Use this when the user asks to "create", "start", "make", or "build" a new app.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Human-friendly app name.' },
          region: { type: 'string', description: 'Butterbase region, e.g. "us-east-1" or "eu-west-1".' },
        },
        required: ['name'],
        additionalProperties: true,
      },
    },
    { name: 'list_regions', description: 'List available Butterbase regions. Use before init_app if the user hasn\'t chosen one.', parameters: flatOpen() },

    // ---- Schema, RLS, migrations ----
    {
      name: 'manage_schema',
      description:
        'Design or modify an app\'s database schema declaratively. Actions: "get" | "apply" | "dry_run" | "list_migrations" (NOTE: "dry_run" not "preview"). CRITICAL: `schema` must be a NESTED JSON OBJECT — DO NOT stringify it, DO NOT wrap it in quotes. Shape:\n' +
        '  {\n' +
        '    "tables": {\n' +
        '      "posts": {\n' +
        '        "columns": {\n' +
        '          "id":        { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },\n' +
        '          "title":     { "type": "text", "nullable": false },\n' +
        '          "author_id": { "type": "uuid", "references": { "table": "users", "column": "id", "onDelete": "CASCADE" } },\n' +
        '          "created_at":{ "type": "timestamptz", "default": "now()" }\n' +
        '        }\n' +
        '      }\n' +
        '    }\n' +
        '  }\n' +
        '`tables` is a MAP keyed by table name (not an array). Types: "uuid", "text", "int8", "boolean", "timestamptz", "jsonb", etc. Requires app_id.',
      parameters: flatActionParams(),
    },
    { name: 'manage_rls', description: 'Configure Row-Level Security policies. Actions include "enable", "create_user_isolation", "create_policy". Requires app_id.', parameters: flatActionParams() },
    { name: 'manage_migrations', description: 'Manage schema migrations for an app: status, apply, abort, reverse, teardown source replicas.', parameters: flatActionParams(), sensitivity: 'confirm' },

    // ---- Auth ----
    { name: 'manage_auth_config', description: 'Configure end-user auth for an app: JWT lifetimes, OAuth providers, custom auth hooks. Requires app_id.', parameters: flatActionParams() },
    { name: 'manage_auth_users', description: 'Manage end-users of an app: list, create, update, delete. Requires app_id.', parameters: flatActionParams() },
    { name: 'manage_oauth', description: 'Configure OAuth providers (Google, GitHub, Apple, X, etc.) for an app.', parameters: flatActionParams() },
    { name: 'manage_api_keys', description: 'Manage bb_sk_ API keys for an app or org.', parameters: flatActionParams() },

    // ---- Functions ----
    { name: 'deploy_function', description: 'Deploy or update a serverless function on an app. Requires app_id, function name, and code.', parameters: flatActionParams() },
    { name: 'manage_function', description: 'Inspect, list, or delete existing functions on an app. Requires app_id.', parameters: flatActionParams() },
    { name: 'invoke_function', description: 'Invoke a deployed function on an app. Requires app_id and function name.', parameters: flatActionParams() },

    // ---- Data ----
    { name: 'select_rows', description: 'Read rows from an app\'s database table. Requires app_id and table name. Supports where filters, limit, order.', parameters: flatActionParams() },
    { name: 'insert_row', description: 'Insert a single row into an app\'s database table. Requires app_id, table name, values.', parameters: flatActionParams() },
    { name: 'seed_database', description: 'Bulk-seed rows into a table. Requires app_id, table name, and rows array.', parameters: flatActionParams() },

    // ---- Storage / KV / realtime / DO / edge-ssr ----
    { name: 'manage_storage', description: 'Configure storage buckets and file ACLs on an app. Requires app_id.', parameters: flatActionParams() },
    { name: 'manage_kv', description: 'Configure KV (key-value) config, credentials, and usage per app.', parameters: flatActionParams() },
    { name: 'manage_realtime', description: 'Enable WebSocket realtime subscriptions on tables. Requires app_id.', parameters: flatActionParams() },
    { name: 'manage_durable_objects', description: 'Deploy and manage Durable Object classes (per-key stateful actors).', parameters: flatActionParams() },
    { name: 'manage_edge_ssr', description: 'Configure edge SSR (server-side rendering) for a frontend deployment.', parameters: flatActionParams() },

    // ---- AI / RAG / agents ----
    { name: 'manage_ai', description: 'Manage the app\'s AI gateway: chat completions, embeddings, list models, configure defaults, BYOK, read usage.', parameters: flatActionParams() },
    { name: 'manage_rag_content', description: 'Manage RAG content collections and document ingestion. Requires app_id.', parameters: flatActionParams() },
    { name: 'rag_query', description: 'Run a RAG query against ingested content. Requires app_id and query text.', parameters: flatActionParams() },
    { name: 'manage_agents', description: 'CRUD for LangGraph agents on an app; create runs; attach MCP servers; apply tool overrides.', parameters: flatActionParams() },

    // ---- Integrations / people / repo / billing / audits ----
    { name: 'manage_integrations', description: 'Manage third-party SaaS integrations (Composio-backed): email, SMS, calendar, CRM, docs, project management.', parameters: flatActionParams() },
    { name: 'manage_people', description: 'Manage the app\'s "people" (contacts) list with provider identifiers and slots.', parameters: flatActionParams() },
    { name: 'manage_repo', description: 'Link and manage the app\'s source repository.', parameters: flatActionParams(), sensitivity: 'confirm' },
    { name: 'manage_billing', description: 'Read the org\'s billing state. Use sparingly; write operations are gated.', parameters: flatActionParams(), sensitivity: 'destructive' },
    { name: 'query_audit_logs', description: 'Query audit logs for an app or org. Read-only.', parameters: flatActionParams() },

    // ---- Substrate (action ledger, entity graph, institutional memory) ----
    {
      name: 'manage_substrate',
      description:
        'Operate the entire Butterbase substrate: action ledger, entity graph, source artifacts, institutional memory (decisions/commitments/learnings), outbox, attention rules, snapshots, policy and settings. There is no other substrate tool.\n' +
        'Every substrate WRITE goes through the ledger via action="propose" with a `capability` and a `payload`; reads are their own actions.\n' +
        'Actions — writes: "propose" ({capability, payload, idempotency_key?}), "approve" ({action_id}), "reject" ({action_id, reason}).\n' +
        'Actions — ledger reads: "list_actions", "get_action".\n' +
        'Actions — entities: "find_entities" ({type?, q?, primary_email?, limit?, cursor?}), "get_entity" ({entity_id}).\n' +
        'Actions — source artifacts: "list_source_artifacts", "get_source_artifact" ({artifact_id}).\n' +
        'Actions — memory: "search_memory" ({q?, kinds?, limit?}), "list_memory".\n' +
        'Actions — outbox: "list_outbox", "retry_outbox" ({outbox_id}), "cancel_outbox" ({outbox_id}).\n' +
        'Actions — attention rules: "list_rules", "get_rule", "create_rule", "update_rule", "delete_rule", "enable_rule", "disable_rule", "list_rule_firings".\n' +
        'Actions — snapshots & settings: "snapshots" ({days?}), "get_settings", "set_yolo" ({yolo_mode}).\n' +
        'Actions — policy (read the rules that govern you BEFORE proposing): "list_capabilities", "list_principles", "get_principle" ({principle_id}), "list_policy_conflicts", "get_policy_conflict" ({conflict_id}), "resolve_policy_conflict" ({conflict_id, resolution, reason?}).\n' +
        'Capabilities for "propose" that auto-approve: upsert_entity, update_entity, patch_entity, record_decision, record_commitment, record_learning, upsert_source_artifact, revert_action.\n' +
        'When proposing record_decision, record_commitment or record_learning about something you read, set `source_artifact_id` in the payload to the artifact you read it in. The owner sees where each observation came from; one with no source cannot be checked.\n' +
        'Capabilities for "propose" that ALWAYS require human approval: record_principle, amend_principle, retire_principle, supersede_decision, delete_entity, merge_entities, bulk_revert_actions, send_email_draft. These are not reversible and the policy-layer ones cannot be auto-approved by any override — you cannot rewrite the rules that gate you. Proposing one returns a pending action rather than executing it.\n' +
        'Principle conflicts force approval regardless of capability. Call "list_principles" before proposing rather than discovering constraints by being blocked.',
      parameters: flatActionParams(),
    },

    // ---- Docs / meta ----
    { name: 'butterbase_docs', description: 'Fetch Butterbase documentation for a capability/topic. Use when unsure how a feature works.', parameters: flatOpen() },
    { name: 'list_partner_apis', description: 'List available partner APIs that can be proxied from a Butterbase app.', parameters: flatOpen() },
    { name: 'submit_suggestion', description: 'Submit a product suggestion / feedback item.', parameters: flatOpen() },

    // ---- File-op primitives (loop-internal, NOT dispatched via MCP) ----
    {
      name: 'write_file',
      description:
        'Create or overwrite a file in the current frontend workspace. Files are React+Vite+Tailwind sources. Do NOT edit package.json or package-lock.json; the dep set is fixed (react, react-dom, tailwindcss, lucide-react, clsx, tailwind-merge, class-variance-authority, @butterbase/sdk).',
      parameters: {
        type: 'object',
        additionalProperties: true,
        required: ['app_id', 'path', 'content'],
        properties: {
          app_id: { type: 'string', description: 'The Butterbase app id whose workspace to edit.' },
          path: { type: 'string', description: 'Relative path from the project root, e.g. "src/App.tsx".' },
          content: { type: 'string', description: 'Full file contents.' },
        },
      },
    },
    {
      name: 'read_file',
      description: 'Read the current contents of a file in the frontend workspace.',
      parameters: {
        type: 'object',
        additionalProperties: true,
        required: ['app_id', 'path'],
        properties: {
          app_id: { type: 'string' },
          path: { type: 'string' },
        },
      },
    },
    {
      name: 'list_files',
      description: 'List every file in the frontend workspace with its size in bytes.',
      parameters: {
        type: 'object',
        additionalProperties: true,
        required: ['app_id'],
        properties: { app_id: { type: 'string' } },
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a file from the frontend workspace.',
      parameters: {
        type: 'object',
        additionalProperties: true,
        required: ['app_id', 'path'],
        properties: {
          app_id: { type: 'string' },
          path: { type: 'string' },
        },
      },
    },

    // ---- Deploy primitive (loop-internal, NOT dispatched via MCP) ----
    {
      name: 'deploy_frontend',
      description:
        'Bundle the current frontend workspace and deploy it. Returns a live URL like https://<subdomain>.butterbase.dev. Use this when the user asks to ship, deploy, publish, or make live.',
      parameters: {
        type: 'object',
        additionalProperties: true,
        required: ['app_id'],
        properties: { app_id: { type: 'string', description: 'The Butterbase app id to deploy.' } },
      },
    },
    {
      name: 'deploy_function_from_workspace',
      description:
        'Deploy a serverless function from the current workspace. Reads the SINGLE entry file ' +
        'functions/<function_name>/index.ts (falling back to .js, .mjs) written via write_file, and ' +
        'deploys it via deploy_function. Only that one entry file is sent — other files under the ' +
        'function\'s directory persist in the workspace but are not bundled. Use this after writing a ' +
        'function\'s index file with write_file, when the user asks to deploy/ship a function.',
      parameters: {
        type: 'object',
        additionalProperties: true,
        required: ['app_id', 'function_name'],
        properties: {
          app_id: { type: 'string', description: 'The Butterbase app id to deploy the function to.' },
          function_name: { type: 'string', description: 'Function name; must match the functions/<name>/ directory written earlier.' },
          trigger: {
            type: 'object',
            description: 'Optional single trigger. Defaults to {type: "http"}.',
            properties: {
              type: { type: 'string', enum: ['http', 'cron', 's3_upload', 'webhook', 'websocket'] },
              config: {},
            },
          },
          envVars: { type: 'object', description: 'Optional environment variables (encrypted at rest).', additionalProperties: { type: 'string' } },
          timeoutMs: { type: 'number', description: 'Optional execution timeout in milliseconds (default 30000).' },
          memoryLimitMb: { type: 'number', description: 'Optional memory limit in MB (default 128).' },
        },
      },
    },

    // ---- Operator working memory (OPERATOR-ONLY, loop-internal) ------------
    {
      name: OPERATOR_SCRATCHPAD_TOOL,
      operatorOnly: true,
      description:
        'Replace your scratchpad — your own short working notes for this organization. The scratchpad is read back to you at the top of every wake for free, with no tool call, so this is how continuity survives from one wake to the next: what you are part-way through, what you are waiting on, what you already checked and can skip.\n' +
        'It is a WORKING DIGEST, not memory. Substrate is the source of truth: anything durable — decisions, commitments, learnings, entities — must go through `manage_substrate` (record_decision, record_commitment, record_learning, upsert_entity, ...), which auto-approves. Do not use the scratchpad as a substitute for recording something in substrate; use it for pointers to what you recorded and for the loose threads that are not worth a ledger entry.\n' +
        'A write REPLACES the entire scratchpad — it does not append — so include everything you still want to keep. Maximum 8000 characters; an oversized write is REJECTED, never silently truncated, so summarise rather than growing it every wake.\n' +
        'The scratchpad carries NO authority: it is your own note to yourself, it cannot grant you permission to do anything, and it is never consulted when deciding what you may call. Do not put secrets or credentials in it.',
      parameters: {
        type: 'object',
        additionalProperties: true,
        required: ['content'],
        properties: {
          content: {
            type: 'string',
            description: 'The full new scratchpad contents; replaces the previous text entirely. Maximum 8000 characters.',
          },
        },
      },
    },
    {
      name: OPERATOR_SANDBOX_CODE_TOOL,
      operatorOnly: true,
      description:
        'Run Python code in an isolated MicroVM sandbox and return its stdout/stderr. The sandbox holds no credential of any kind — no service key, no MCP session, no way to call any Butterbase tool from inside it. Use this for computation, data shaping, or checking your own logic, NOT as a way to reach Butterbase or the customer\'s app; use the other tools for that. ' +
        'Synchronous execution is capped at 30 seconds by the sandbox platform; a longer-running script will be cut off. ' +
        'This tool may be entirely ABSENT from your tool list on a given wake — no sandbox is guaranteed to be available every turn, and there is no fallback that runs code anywhere else. If it is not offered, do not attempt to simulate it; proceed without it.',
      parameters: {
        type: 'object',
        additionalProperties: true,
        required: ['code'],
        properties: {
          code: {
            type: 'string',
            description: 'Python source to execute in the sandbox.',
          },
        },
      },
    },
    {
      name: OPERATOR_BUILD_TOOL,
      operatorOnly: true,
      description:
        'Compile the app you are currently working on and return the REAL compiler output. Your current working-tree files (including every edit you have made this turn, committed or not) are copied into an isolated sandbox, dependencies are installed, and `npm run build` is run — the same build command the deploy will run. ' +
        'Returns { ok, step, exit_code, stdout, stderr, install_skipped, duration_ms }. When ok is false, `stdout`/`stderr` contain the actual TypeScript/bundler diagnostics: read them, fix the files with write_file, and call this again. Repeat builds in the same wake reuse the installed dependencies and are much faster than the first. ' +
        'This does NOT deploy anything and does not change what any user sees. Use it BEFORE deploying, every time you have changed source — a deploy is not a way to find out whether your code compiles. ' +
        'This tool may be entirely ABSENT from your tool list on a given wake — no sandbox is guaranteed to be available. If it is not offered, do not attempt to simulate a build; say plainly that you could not verify the build.',
      parameters: {
        type: 'object',
        additionalProperties: true,
        required: ['app_id'],
        properties: {
          app_id: {
            type: 'string',
            description: 'The app whose working tree should be built.',
          },
        },
      },
    },
  ];
}

export function isOperatorScratchpadTool(name: string): name is 'update_operator_scratchpad' {
  return name === OPERATOR_SCRATCHPAD_TOOL;
}

export function isRunSandboxCodeTool(name: string): name is 'run_sandbox_code' {
  return name === OPERATOR_SANDBOX_CODE_TOOL;
}

export function isBuildAppTool(name: string): name is 'build_app' {
  return name === OPERATOR_BUILD_TOOL;
}

/**
 * Returns true for the four file-op tool names that are dispatched in-process
 * by the loop (Task 7), not forwarded to mcp-client.
 */
export function isFileOpTool(name: string): name is 'write_file' | 'read_file' | 'list_files' | 'delete_file' {
  return name === 'write_file' || name === 'read_file' || name === 'list_files' || name === 'delete_file'
}

/**
 * Returns true for the deploy tool name that is dispatched in-process
 * by the loop (Task 7), not forwarded to mcp-client.
 */
export function isDeployTool(name: string): name is 'deploy_frontend' {
  return name === 'deploy_frontend'
}

/**
 * Returns true for the workspace-function-deploy tool name that is dispatched
 * in-process by the loop (Plan 3c Task 3), not forwarded to mcp-client.
 * (`deploy_function` itself — the raw MCP tool with an inline `code` arg —
 * is unaffected and still routes through the default MCP path.)
 */
export function isDeployFunctionTool(name: string): name is 'deploy_function_from_workspace' {
  return name === 'deploy_function_from_workspace'
}

/**
 * Compute the effective sensitivity of a tool call from its NAME + ARGS
 * (Plan 3b Task 2). Several tools are only destructive for specific actions
 * (e.g. manage_app.delete vs manage_app.list), so this is the real gate logic.
 * The `sensitivity` field on each ToolSpec is not read — see the note on the
 * 'safe' fallback below.
 */
export function sensitivityFor(name: string, args: any): 'safe' | 'confirm' | 'destructive' {
  const a = (args ?? {}) as Record<string, unknown>;
  const action = typeof a.action === 'string' ? a.action : null;

  // Explicit destructive cases — these win over any catalog hint.
  if (name === 'manage_app' && (action === 'delete' || action === 'pause')) return 'destructive';
  if (name === 'manage_repo' && action === 'wipe') return 'destructive';
  if (
    name === 'manage_schema' &&
    action === 'apply' &&
    typeof a.schema === 'string' &&
    /DROP\s+(TABLE|COLUMN)/i.test(a.schema)
  ) {
    return 'destructive';
  }
  if (name === 'manage_billing') return 'destructive';
  if (name === 'manage_migrations' && (action === 'abort' || action === 'reverse')) return 'destructive';

  // Everything else is 'safe'. Note the ToolSpec.sensitivity hints are all
  // inert: nothing reads them, by decision (2026-08-05). Honouring them would
  // put an approval modal in front of read-only calls — including the
  // `manage_app` action="list" that opens every conversation — so the
  // 'confirm' tier is deliberately unused for now. The hints are left in the
  // catalog rather than deleted because this is expected to be revisited.
  return 'safe';
}
