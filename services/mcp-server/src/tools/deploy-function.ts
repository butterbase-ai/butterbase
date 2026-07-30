import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiPost } from '../api-client.js';

export function registerDeployFunction(server: McpServer) {
  server.tool(
    'deploy_function',
    `Deploy or update a serverless function with custom business logic.

Example:
  Input: {
    app_id: "app_abc123",
    name: "send-welcome-email",
    code: "export async function handler(req, ctx) { ... }",
    trigger: {
      type: "http",
      config: { method: "POST", path: "/welcome", auth: "required" }
    }
  }
  Output: {
    function_id: "fn_xyz789",
    name: "send-welcome-email",
    url: "https://api.butterbase.ai/v1/app_abc123/fn/send-welcome-email",
    status: "deployed"
  }

Function signature:
  export async function handler(request: Request, context: {
    db: PostgresClient,    // Query your app database
    env: Record<string, string>,  // Access envVars
    user: { id: string } | null,  // Current user (if auth: required)
    waitUntil: (promise: Promise) => void,  // Keep alive for background work after response
    idempotency: {                          // Webhook / event dedup primitive
      claim: (key: string, opts?: { scope?: string; ttlSeconds?: number }) => Promise<boolean>
    }
  }): Promise<Response>

Console output: console.log(), console.info(), console.warn(), console.error(), and console.debug() calls are captured and stored with invocation logs. View them via manage_function (action: "get_logs").

IMPORTANT: Handlers MUST return a Response object (Web API standard).
Do NOT return plain objects like { status: 200, body: "..." }.

Idempotent webhook handlers with ctx.idempotency.claim():
  Third-party webhook providers (Stripe, Telegram, GitHub, Slack, Twilio, Discord)
  retry delivery on non-2xx responses with the same event id. Use ctx.idempotency.claim()
  to atomically dedupe — it returns true if you're the first to see this key, false if
  another invocation already claimed it.

  export async function handler(req, ctx) {
    const event = await req.json();
    if (!(await ctx.idempotency.claim(event.id))) {
      // Already processed — ack the retry without re-doing work.
      return new Response('duplicate', { status: 200 });
    }
    await processEvent(event);
    return new Response('ok', { status: 200 });
  }

  Options:
    - scope: 'stripe' | 'telegram' | ... (default: 'default'). Namespace claims so
      keys from different providers can never collide.
    - ttlSeconds: mark the claim with an expiry. Cleanup is your responsibility:
      DELETE FROM _idempotency_keys WHERE expires_at < now();

Background work with ctx.waitUntil():
  Use ctx.waitUntil(promise) to keep the function alive after the response is sent.
  This is useful for fire-and-forget tasks like sending emails or logging.
  Background work has a 30-second timeout. ctx.db is available inside waitUntil promises.

  export async function handler(req, ctx) {
    ctx.waitUntil(fetch("https://api.email.com/send", { method: "POST", body: "..." }));
    return new Response(JSON.stringify({ accepted: true }), {
      headers: { "Content-Type": "application/json" }
    });
  }

Example:
  export async function handler(req, ctx) {
    const data = { hello: "world" };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

Server-to-server calls from inside a function:
  - ctx.invoke('fn-name', body?, opts?) — call a sibling function in the same app.
    Platform-managed bearer, no env plumbing. ctx.user.id propagates automatically;
    the callee sees ctx.caller.type === 'loopback'. Loop-depth capped at 4.
  - ctx.invokeDO('class-name', 'instance-key', body?, opts?) — call a sibling
    Durable Object in the same app. Routed through a platform shim; no public
    URL or bearer to plumb. Depth shared with ctx.invoke.
  See docs → Functions → Server-to-server, and Durable Objects → Server-to-server.

Row-Level Security in Functions:
  Functions respect RLS policies based on how they're invoked:

  - Invoked with end-user JWT → butterbase_user role (RLS enforced)
    * ctx.db queries see only the user's data
    * ctx.user.id contains the authenticated user ID
    * Use case: User-facing operations

  - Invoked with platform API key → butterbase_service role (RLS bypassed)
    * ctx.db queries see all data
    * ctx.user is null
    * Use case: Admin operations, background jobs

  - Invoked by cron trigger → butterbase_service role (RLS bypassed)
    * ctx.db queries see all data
    * ctx.user is null
    * Use case: Scheduled tasks, cleanup jobs

Trigger types:
  - http: Invoke via HTTP request (GET, POST, etc)
  - cron: Schedule periodic execution (e.g., "0 9 * * *" = daily at 9am)
  - websocket: Trigger on WebSocket event from client via realtime connection
  - s3_upload: Trigger on file upload [not yet implemented]
  - webhook: Receive webhooks from external services [not yet implemented]

Common errors:
  - VALIDATION_INVALID_SCHEMA: Check code exports a handler function
  - RESOURCE_NOT_FOUND: App doesn't exist
  - Syntax error: Code must be valid TypeScript/JavaScript

Idempotency: Safe to call multiple times (updates existing function with same name).

Next steps: Use invoke_function to test, then manage_function (action: "get_logs") to debug.`,
    {
      app_id: z.string().describe('The app ID to deploy the function to'),
      name: z.string().describe('Function name (alphanumeric, hyphens, underscores)'),
      code: z.string().describe('TypeScript/JavaScript code that exports a handler function'),
      description: z.string().optional().describe('Function description'),
      envVars: z.record(z.string()).optional().describe('Environment variables (will be encrypted)'),
      timeoutMs: z.number().optional().describe('Execution timeout in milliseconds (default: 30000)'),
      memoryLimitMb: z.number().optional().describe('Memory limit in MB (default: 128)'),
      trigger: z.object({
        type: z.enum(['http', 'cron', 's3_upload', 'webhook', 'websocket']).describe('Trigger type'),
        config: z.any().describe('Trigger-specific config (see triggers param for shape).'),
      }).optional().describe('Single-trigger shorthand. Prefer `triggers` for new code; this is kept for back-compat.'),
      triggers: z.array(z.object({
        type: z.enum(['http', 'cron', 's3_upload', 'webhook', 'websocket']).describe('Trigger type: http, cron, s3_upload, webhook, or websocket'),
        config: z.any().describe(`Trigger-specific configuration:
- http: { method?: string, path?: string, auth?: 'required'|'optional'|'none' }
  * auth defaults to 'required' for new HTTP functions — anonymous callers get 401 at the edge.
  * Set auth: 'none' ONLY for intentionally public endpoints. Inside such a function, ctx.db runs
    as butterbase_service (RLS bypassed), so guard every DB access manually or hand-check ctx.user.
- cron: { schedule: string (cron expression like "0 9 * * *"), timezone?: string (default: UTC) }
- s3_upload: { bucket: string, prefix?: string, contentTypes?: string[] }
- webhook: { secret_required?: boolean, allowed_sources?: string }
- websocket: {} Trigger on incoming WebSocket frames`),
        enabled: z.boolean().optional().describe('Default true.'),
      })).min(1).optional().describe('Canonical multi-trigger array. At most one trigger per type.'),
      agent_tool: z.boolean().optional().describe(
        'When true, this function is exposed to agents in this app as a tool. ' +
        'Agents must still list its name under their graph_spec.tools.functions[] to call it.'
      ),
      agent_tool_description: z.string().max(500).optional().describe(
        'Short imperative description shown to the LLM (max 500 chars). ' +
        'Required for any function the model is expected to choose intelligently.'
      ),
      agent_tool_mode: z.enum(['read_only', 'read_write']).optional().describe(
        'read_only (default) | read_write. read_write tools require human approval per call (HITL).'
      ),
      agent_tool_exposed_to: z.enum(['developer_only', 'end_user']).optional().describe(
        'developer_only (default) — only dashboard/CLI test runs can call it. ' +
        'end_user — also callable by public agent invocations.'
      ),
      allow_service_key_impersonation: z.boolean().optional().describe(
        'Default true. Lets an app-scoped service-key caller assert "act as ' +
        'user X" via the X-Butterbase-As-User header — the runtime populates ' +
        'ctx.user with the asserted id before invoking. Set to false on ' +
        'admin-only or billing-webhook handlers that must never accept an ' +
        'as-user assertion: control-api will 403 such calls at the edge.'
      ),
    },
    {
      title: 'Deploy Function',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const {
        app_id, name, code, description, envVars, timeoutMs, memoryLimitMb,
        trigger, triggers,
        agent_tool, agent_tool_description, agent_tool_mode, agent_tool_exposed_to,
        allow_service_key_impersonation,
      } = args;

      const result = await apiPost(`/v1/${app_id}/functions`, {
        name,
        code,
        description,
        envVars,
        timeoutMs,
        memoryLimitMb,
        ...(triggers ? { triggers } : {}),
        ...(!triggers && trigger ? { trigger } : {}),
        ...(agent_tool !== undefined ? { agent_tool } : {}),
        ...(agent_tool_description !== undefined ? { agent_tool_description } : {}),
        ...(agent_tool_mode !== undefined ? { agent_tool_mode } : {}),
        ...(agent_tool_exposed_to !== undefined ? { agent_tool_exposed_to } : {}),
        ...(allow_service_key_impersonation !== undefined ? { allow_service_key_impersonation } : {}),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
