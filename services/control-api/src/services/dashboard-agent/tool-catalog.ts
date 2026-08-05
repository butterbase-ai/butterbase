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
  ];
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
