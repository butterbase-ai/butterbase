import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerInitApp } from './tools/init-app.js';
import { registerManageSchema } from './tools/manage-schema.js';
import { registerManageRls } from './tools/manage-rls.js';
import { registerManageOAuth } from './tools/manage-oauth.js';
import { registerDocs } from './tools/docs.js';
import { registerManageStorage } from './tools/manage-storage.js';
import { registerQueryAuditLogs } from './tools/query-audit-logs.js';
import { registerDeployFunction } from './tools/deploy-function.js';
import { registerInvokeFunction } from './tools/invoke-function.js';
import { registerManageFunction } from './tools/manage-function.js';
import { registerSubmitSuggestion } from './tools/submit-suggestion.js';
import { registerSelectRows } from './tools/select-rows.js';
import { registerInsertRow } from './tools/insert-row.js';
import { registerCreateFrontendDeployment } from './tools/deploy-frontend.js';
import { registerManageEdgeSsr } from './tools/manage-edge-ssr.js';
import { registerManageFrontend } from './tools/manage-frontend.js';
import { registerManageRealtime } from './tools/manage-realtime.js';
import { registerManageAuthUsers } from './tools/manage-auth-users.js';
import { registerSeedDatabase } from './tools/seed-database.js';
import { registerManageRagContent } from './tools/manage-rag-content.js';
import { registerRagQuery } from './tools/rag-query.js';
import { registerIntegrations } from './tools/integrations.js';
import { registerManageAuthConfig } from './tools/manage-auth-config.js';
import { registerManageApp } from './tools/manage-app.js';
import { registerSubmitHackathonEntry } from './tools/submit-hackathon-entry.js';
import { registerListPartnerApis } from './tools/list-partner-apis.js';
import { registerManageDurableObjects } from './tools/manage-durable-objects.js';
import { registerManageAi } from './tools/manage-ai.js';
import { registerBilling } from './tools/billing.js';
import { registerApiKeys } from './tools/api-keys.js';
import { registerMoveApp } from './tools/move-app.js';
import { registerListRegions } from './tools/list-regions.js';
import { registerManageMigrations } from './tools/manage-migrations.js';
import { registerManageKv } from './tools/manage-kv.js';
import { startActiveWindowListener } from './eligibility-listener.js';
import { isActiveWindowCached, startActiveWindowPoller } from './active-window-cache.js';
export { runWithRequestAuthorizationHeader, getRequestAuthorizationHeader } from './request-auth-context.js';

// Prime and maintain the process-wide active-window cache.
// When a Postgres connection string is available, also listen for NOTIFY
// so the cache is invalidated immediately on hackathon activate/deactivate.
startActiveWindowPoller();

if (process.env.CONTROL_DB_URL) {
  void startActiveWindowListener(process.env.CONTROL_DB_URL).catch((err) =>
    console.error('failed to start active-window listener', err)
  );
}

/**
 * Filter the tools list based on whether any hackathon is currently within
 * its submission window (public /active endpoint: date range, not is_active).
 * submit_hackathon_entry is hidden when no hackathon dates include "now".
 * Per-user eligibility is NOT checked here — the submission code at submit time is the gate.
 */
export function filterToolsByActiveWindow<T extends { name: string }>(
  tools: T[],
  activeWindow: boolean,
): T[] {
  return activeWindow ? tools : tools.filter(t => t.name !== 'submit_hackathon_entry');
}


export function createButterbaseMcpServer() {
  const server = new McpServer({
    name: 'butterbase',
    version: '0.1.0',
  });

  registerInitApp(server);
  registerManageSchema(server);
  registerManageRls(server);
  registerManageOAuth(server);
  registerDocs(server);
  registerManageStorage(server);
  registerManageKv(server);
  registerQueryAuditLogs(server);
  registerDeployFunction(server);
  registerInvokeFunction(server);
  registerManageFunction(server);
  registerSelectRows(server);
  registerInsertRow(server);
  registerCreateFrontendDeployment(server);
  registerManageEdgeSsr(server);
  registerManageFrontend(server);
  registerSubmitSuggestion(server);
  registerManageRealtime(server);
  registerManageAuthUsers(server);
  registerSeedDatabase(server);
  registerManageRagContent(server);
  registerRagQuery(server);
  registerIntegrations(server);
  registerManageAuthConfig(server);
  registerManageApp(server);
  registerSubmitHackathonEntry(server);
  registerManageDurableObjects(server);
  registerManageAi(server);
  registerBilling(server);
  registerApiKeys(server);
  registerMoveApp(server);
  registerListRegions(server);
  registerManageMigrations(server);
  if (process.env.PARTNER_PROXY_ENABLED === 'true') {
    registerListPartnerApis(server);
  }

  server.registerPrompt(
    'quickstart',
    {
      description: 'Step-by-step guide to create and configure a Butterbase app',
      argsSchema: {
        app_name: z.string().optional().describe('Name for the new app (e.g. my-app)'),
      },
    },
    async ({ app_name }) => {
      const name = app_name || 'my-app';
      return {
        messages: [
          {
            role: 'assistant' as const,
            content: {
              type: 'text' as const,
              text: [
                `# Butterbase Quickstart`,
                ``,
                `Follow these steps to set up a new backend:`,
                ``,
                `## 1. Create an app`,
                `Call **init_app** with name: "${name}"`,
                ``,
                `## 2. Define your schema`,
                `Call **manage_schema** (action: "apply") with your table definitions (columns, types, indexes).`,
                `Use action: "dry_run" first to preview changes.`,
                ``,
                `## 3. Insert data`,
                `Use **insert_row** or **seed_database** to populate tables.`,
                ``,
                `## 4. Query data`,
                `Use **select_rows** to read data with filters, sorting, and pagination.`,
                ``,
                `## 5. Add auth (optional)`,
                `Call **manage_rls** (action: "enable" or "create_user_isolation").`,
                ``,
                `## 6. Deploy functions (optional)`,
                `Call **deploy_function** with your handler code and trigger config.`,
                ``,
                `## 7. Deploy frontend (optional)`,
                `Call **create_frontend_deployment** (or **deploy_frontend**) then **manage_frontend** (action: "start_deployment").`,
                ``,
                `## Useful tools`,
                `- **manage_app** (action: "list") — see all your apps`,
                `- **manage_schema** (action: "get") — inspect current schema`,
                `- **butterbase_docs** — read full documentation`,
                `- **manage_app** (action: "get_config") — view app settings and API base URL`,
              ].join('\n'),
            },
          },
        ],
      };
    }
  );

  // Post-registration fixups on the internal tool map.
  const registeredTools = (server as unknown as {
    _registeredTools: Record<string, {
      inputSchema: z.ZodTypeAny;
      title?: string;
      annotations?: { title?: string };
    }>;
  })._registeredTools;

  for (const tool of Object.values(registeredTools)) {
    // Promote annotations.title → tool.title so the MCP protocol includes it
    // at the top level (required by Smithery "Tool names" quality check).
    if (tool.annotations?.title && !tool.title) {
      tool.title = tool.annotations.title;
    }

    // Apply strict validation so unknown arguments are rejected
    // rather than silently stripped. This catches AI model hallucinated field names early.
    // Skip tools with empty schemas — strict() on an empty object
    // breaks zod-to-json-schema conversion.
    const schema = tool.inputSchema as z.ZodObject<z.ZodRawShape> | undefined;
    if (schema && typeof schema.strict === 'function' && schema.shape && Object.keys(schema.shape).length > 0) {
      tool.inputSchema = schema.strict();
    }
  }

  // Wrap the SDK's already-installed ListTools handler to hide the hackathon
  // submit tool when no hackathon is currently within its submission window.
  // The tool is visible to every authenticated user when a hackathon IS active —
  // per-user eligibility is no longer checked here; the submission code passed
  // at call time is the gate.
  const lowLevel = server.server as unknown as {
    _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
  };
  const originalListTools = lowLevel._requestHandlers.get('tools/list');
  if (!originalListTools) {
    throw new Error(
      'MCP SDK private surface changed: ListTools handler not found in _requestHandlers. ' +
      'The active-window tool filter requires this hook — refusing to start to avoid ' +
      'silently exposing submit_hackathon_entry outside a hackathon window. Investigate SDK changes.'
    );
  }
  lowLevel._requestHandlers.set('tools/list', async (request, extra) => {
    const original = (await originalListTools(request, extra)) as { tools: Array<{ name: string }>; [k: string]: unknown };
    return { ...original, tools: filterToolsByActiveWindow(original.tools, isActiveWindowCached()) };
  });

  return server;
}
